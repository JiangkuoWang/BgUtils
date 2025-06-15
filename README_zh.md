# 简介
本库提供了生成 PO Token 和执行认证挑战的工具，通过逆向工程研究了 YouTube 网页播放器如何与 BotGuard 和 Web Anti-Abuse API 进行交互。

- [简介](#简介)
  - [重要说明](#重要说明)
  - [使用方法](#使用方法)
  - [研究内容](#研究内容)
    - [初始化过程](#初始化过程)
    - [获取完整性令牌](#获取完整性令牌)
    - [铸造 WebPO Token](#铸造-webpo-token)
    - [何时使用 PO Token](#何时使用-po-token)
  - [许可证](#许可证)

## 重要说明

1. BotGuard 是 Google 用来保护其服务免受滥用并验证请求来源于合法客户端的安全机制。本库提供了 YouTube 网页播放器用于生成 PO Token 和运行认证挑战过程的逆向工程实现。但是，**它并不绕过 BotGuard**；您仍然需要一个符合其检查要求的合规环境才能使用此库。

2. 本库仅用于教育目的，与 Google 或 YouTube 无关。我不对本库的任何误用负责。

## 使用方法

请参考提供的示例 [这里](./examples/)。

## 研究内容

以下是生成 PO Token 过程的简要概述，供对库内部工作原理感兴趣的人参考。此信息基于我自己的研究，可能会随着 Google 更新其安全机制而过时。

### 初始化过程

VM 的脚本和相应的字节码程序可以通过三种不同的方式获取：

1. **直接从页面源代码**：
    - (InnerTube) 挑战响应通常嵌入在初始页面的源代码中。
2. **InnerTube API**：
    - InnerTube 有一个可用于检索挑战数据的端点。这通常是最简单的方法，因为响应是可读格式。
3. **Web Anti-Abuse 私有 API**：
    - 用于 BotGuard 的内部 Google API，也被 Google Drive 等服务使用。响应可能会根据 `requestKey` 进行混淆。

WAA 挑战获取器示例：

```ts
type TrustedResource = {
  privateDoNotAccessOrElseSafeScriptWrappedValue: string | null;
  privateDoNotAccessOrElseTrustedResourceUrlWrappedValue: string | null;
}

type DescrambledChallenge = {
  /**
   * JSPB 消息的 ID。
   */
  messageId?: string;
  /**
   * 与挑战相关的脚本。
   */
  interpreterJavascript: TrustedResource;
  /**
   * 脚本的哈希值。如果您想稍后再次获取挑战脚本，这很有用。
   */
  interpreterHash: string;
  /**
   * 挑战程序。
   */
  program: string;
  /**
   * 全局作用域中 VM 的名称。
   */
  globalName: string;
  /**
   * 客户端实验状态 blob。
   */
  clientExperimentsStateBlob?: string;
};

async function fetchWaaChallenge(requestKey: string, interpreterHash?: string): Promise<DescrambledChallenge | undefined> {
  const payload = [ requestKey ];

  if (interpreterHash)
    payload.push(interpreterHash);
  
  const response = await fetch('https://jnn-pa.googleapis.com/$rpc/google.internal.waa.v1.Waa/Create', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json+protobuf',
      'x-goog-api-key': 'AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw',
      'x-user-agent': 'grpc-web-javascript/0.1',
    },
    body: JSON.stringify(payload)
  });

  const rawData = await response.json() as unknown[];

  // 响应可能被混淆。有关示例实现，请参见 src/core/challengeFetcher.ts
  return parseChallengeData(rawData);
};

const challengeResponse = await fetchWaaChallenge('requestKeyHere');

// ...
```

InnerTube 挑战获取器示例（为简单起见，我将在此示例中使用 YouTube.js）：
```ts
import { Innertube, UniversalCache } from 'youtubei.js';

const innertube = await Innertube.create({ cache: new UniversalCache(true) });
const challengeResponse = await innertube.getAttestationChallenge('ENGAGEMENT_TYPE_UNBOUND');

if (!challengeResponse.bg_challenge)
  throw new Error('Could not get challenge');

const interpreterUrl = challengeResponse.bg_challenge.interpreter_url.private_do_not_access_or_else_trusted_resource_url_wrapped_value;
const bgScriptResponse = await fetch(`https:${interpreterUrl}`);
const interpreterJavascript = await bgScriptResponse.text();

// ...
```

要使 VM 可用，您需要以某种方式执行脚本：
```js
if (interpreterJavascript) {
  new Function(interpreterJavascript)();
} else throw new Error('Could not load VM');

// 如果您在类似浏览器的环境中，也可以使用以下方法：
if (!document.getElementById(interpreterHash)) {
  const script = document.createElement('script');
  script.type = 'text/javascript';
  script.id = interpreterHash;
  script.textContent = interpreterJavascript;
  document.head.appendChild(script);
}
```

如果一切顺利，您应该能够像这样访问它：
```js
const globalObject = window || globalThis;
const vm = globalObject[globalName];
console.info(vm);
```

### 获取完整性令牌

这是一个重要步骤，完整性令牌从认证服务器检索并依赖于 BotGuard 响应，可能用于评估运行时环境的完整性。要解决此挑战，您需要调用 BotGuard 并加载字节码程序。

```js
// 假设您以某种方式拥有 VM 和程序。
if (!this.vm)
  throw new Error('[BotGuardClient] VM not found in the global object');

if (!this.vm.a)
  throw new Error('[BotGuardClient] Cannot load program');

const vmFunctionsCallback = (
  asyncSnapshotFunction,
  shutdownFunction,
  passEventFunction,
  checkCameraFunction
) => {
  Object.assign(this.vmFunctions, { asyncSnapshotFunction, shutdownFunction, passEventFunction, checkCameraFunction });
};

try {
  this.syncSnapshotFunction = await this.vm.a(this.program, vmFunctionsCallback, true, undefined, () => { /** no-op */ }, [ [], [] ])[0];
} catch (error) {
  throw new Error(`[BotGuardClient] Failed to load program (${(error as Error).message})`);
}
```

在这里，BotGuard 将返回几个函数，但我们主要对 `asyncSnapshotFunction` 感兴趣。

一旦 `asyncSnapshotFunction` 可用，使用以下参数调用它：
1. 一个接受单个参数的回调函数。此函数将返回认证请求的令牌。
2. 一个包含四个元素的数组：
    - 第1个：`contentBinding`（可选）。
    - 第2个：`signedTimestamp`（可选）。
    - 第3个：`webPoSignalOutput`（可选但在我们的情况下是必需的，BotGuard 将用获取 WebPO 铸造器的函数填充此数组）。
    - 第4个：`skipPrivacyBuffer`（可选）。

这是一个简化的示例：
```js
async function snapshot(args) {
  return new Promise((resolve, reject) => {
    if (!this.vmFunctions.asyncSnapshotFunction)
      return reject(new Error('[BotGuardClient]: Async snapshot function not found'));

    this.vmFunctions.asyncSnapshotFunction((response) => resolve(response), [
      args.contentBinding,
      args.signedTimestamp,
      args.webPoSignalOutput,
      args.skipPrivacyBuffer
    ]);
  });
}
```

然后：
```js
const webPoSignalOutput = [];
const botguardResponse = await snapshot({ webPoSignalOutput });
```

如果到目前为止一切都做对了，您应该有一个令牌和一个包含一个或多个函数的数组。

现在我们可以为完整性令牌请求创建负载。它应该是一个包含两个项目的数组：请求密钥和令牌。

示例：
```ts
type PoIntegrityTokenResponse = {
  integrityToken?: string;
  estimatedTtlSecs: number;
  mintRefreshThreshold: number;
  websafeFallbackToken?: string;
};

/**
 * 创建用于 PO Token（原产地证明）的完整性令牌。
 * @param requestKey - 请求密钥。
 * @param botguardResponse - 有效的 BotGuard 响应。
 */
async function getPoIntegrityToken(requestKey: string, botguardResponse: string): Promise<PoIntegrityTokenResponse> {
  const payload = [ requestKey, botguardResponse ];

  const integrityTokenResponse = await fetch('https://jnn-pa.googleapis.com/$rpc/google.internal.waa.v1.Waa/GenerateIT', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json+protobuf',
      'x-goog-api-key': 'AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw',
      'x-user-agent': 'grpc-web-javascript/0.1',
    },
    body: JSON.stringify(payload)
  });

  const integrityTokenJson = await integrityTokenResponse.json() as [string, number, number, string];

  const [ integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken ] = integrityTokenJson;

  return {
    integrityToken,
    estimatedTtlSecs,
    mintRefreshThreshold,
    websafeFallbackToken
  };
}

const integrityTokenResponse = await getPoIntegrityToken('requestKeyHere', botguardResponse);
```

存储完整性令牌响应和我们之前获得的数组。我们将使用它们来构建我们的 WebPO Token。

### 铸造 WebPO Token

使用完整性令牌（以字节为单位）作为参数调用 `webPoSignalOutput` 数组中的第一个函数：

```js
const getMinter = webPoSignalOutput[0];

if (!getMinter)
  throw new Error('PMD:Undefined');

const mintCallback = await getMinter(base64ToU8(integrityTokenResponse.integrityToken ?? ''));

if (!(mintCallback instanceof Function))
  throw new Error('APF:Failed');
```
如果成功，您将获得一个可用于铸造 WebPO 令牌的函数。使用您想要用作内容绑定的值调用它，例如访问者 ID、数据同步 ID（如果您已登录）或视频 ID。
```js
const result = await mintCallback(new TextEncoder().encode(identifier));

if (!result)
  throw new Error('YNJ:Undefined');

if (!(result instanceof Uint8Array))
  throw new Error('ODM:Invalid');

const poToken = u8ToBase64(result, true);
console.info(poToken);
```

结果将是一个字节序列，长度约为 110-128 字节。对其进行 Base64 编码，您就有了一个 PO Token！

### 何时使用 PO Token

在网页上，YouTube 尝试在用户与播放器交互时立即铸造一个会话绑定的 PO Token，同时也会铸造一个冷启动令牌以确保播放无延迟开始。一旦铸造完成，PO Token 就会在会话的其余时间内重复使用。如果用户刷新页面，将使用缓存的令牌（如果可用，否则使用冷启动令牌），直到新令牌完成铸造，如果由于某种原因失败，播放器将继续使用缓存的令牌，只要其相应的完整性令牌仍然有效。

播放器还会检查一个名为"sps"（`StreamProtectionStatus`）的值，该值包含在每个媒体段响应中（仅在使用 `UMP` 或 `SABR` 时；我们的浏览器示例使用 `UMP`），以确定流是否需要 PO Token。

- **状态 1**：流已经在使用有效的 PO Token，用户有 YouTube Premium 订阅，或者流不需要 PO Token。
- **状态 2**：需要 PO Token，但客户端可以在播放中断之前请求最多 1-2 MB 的数据。
- **状态 3**：在此阶段，播放器无法在没有 PO Token 的情况下请求数据。

#### 令牌类型

- **冷启动令牌**：在会话绑定令牌铸造之前用于启动播放的占位符令牌。它使用简单的 XOR 密码加密，并使用数据同步 ID 或访问者 ID 作为内容绑定。
- **会话绑定令牌**：当用户与播放器交互时生成。如果已登录，它绑定到账户的数据同步 ID，否则使用访问者 ID。
- **内容绑定令牌**：为每个 `/player` 请求生成（`serviceIntegrityDimensions.poToken`）。它绑定到视频 ID，不应被缓存。

## 许可证

根据 [MIT](https://choosealicense.com/licenses/mit/) 许可证分发。

<p align="right">
(<a href="#top">返回顶部</a>)
</p>
