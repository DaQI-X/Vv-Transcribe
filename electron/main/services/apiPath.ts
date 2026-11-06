/**
 * 「用户在接口地址那格填的东西」换成「这一次真的打出去的 URL」——全应用只有这一处做这个决定。
 *
 * 前提没变：那一格填到域名根为止就行，接口路径由应用接上，这是 1.1.1 那句「填了就能连上」的兑现方式。
 * 加这一层是因为**厂商会改路径**。规则只写在我们这边时，对方改一天就得等我们发一版，
 * 而那段时间里用户看到的是一句和他说过的话毫无关系的 404。所以补一条：
 * 用户已经指到端点那层了，就照他说的打，不再重复接一层。
 *
 * 判据用段数，不用白名单（白名单那一份在 `settingsService.APPENDED_ENDPOINT_PATHS`，
 * 它的活是纠正「把配音的端点粘进转写那格」这类串档，仍在归一化那一步先跑）：
 * 我们自己每一条端点路径都在两段以上（`v1/audio/speech`、`v1/t2a_v2`、`api/v1/services/audio/tts/...`），
 * 所以归一化之后剩下的路径——
 * - **不到两段**的一律当「根」：`https://gw/api`（文档里 `.../api/v1` 被剥剩的那一份）、
 *   `https://gw/proxy`（挂在路径前缀底下的自建网关）照旧接上去，不误伤；
 * - **两段以上、且第一层就撞上我们要接的那一层**（`/v1/xxx`、`/api/v1/xxx`）才认成用户填的是端点。
 *
 * `apiBase` 必须是 `normalizeApiBase` 之后的值：两个调用点（真链路、设置里的「测试连接」）都先归一化
 * 再走到这里，否则就是「自检用归一化后的地址、干活用原始地址」那种最难查的分叉（#220/#227/#327）。
 */

/** 域名之后那段路径拆成段；小写比较，因为真实文档里 `V1/Speech_To_Text` 这种大小写都出现过 */
function pathSegments(apiBase: string): string[] {
  const afterOrigin = apiBase.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*/, '')
  return afterOrigin
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.toLowerCase())
}

/**
 * 把这一家要走的接口路径接到归一化后的地址后面。
 *
 * 两种折叠是必须的，都来自真实文档的粘贴形状：
 * - 用户填的已经是一条端点（见文件头）→ 原样返回，不再接一层；
 * - 阿里云文档那条 `.../api/v1` 被归一化剥剩 `.../api`，而我们的路径本身就从 `/api/` 起头，
 *   直接接会得到 `/api/api/v1/...`——认这一次重复。
 */
export function appendApiPath(apiBase: string, path: string): string {
  const ours = path.split('/').filter(Boolean)
  const past = pathSegments(apiBase)
  if (ours.length > 0 && past.length >= 2 && past[0] === (ours[0] ?? '').toLowerCase()) {
    return apiBase
  }
  return apiBase.endsWith('/api') && path.startsWith('/api/') ? `${apiBase}${path.slice(4)}` : `${apiBase}${path}`
}
