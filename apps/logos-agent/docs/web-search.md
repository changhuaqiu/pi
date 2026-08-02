# 受控网络查询

Logos Agent 默认注册 `web_search`，按 Tavily（设置 `TAVILY_API_KEY` 时）→ 搜狗 → Bing RSS 的顺序搜索。任一 Provider 失败或没有结果会继续降级；用户取消不会触发新的 Provider 请求。不需要 Docker 或后台服务。

## 实现

三个 Adapter 都转换成统一的 `WebSearchOperations` Interface。Tavily 固定向 `https://api.tavily.com/search` 发送有界 JSON 请求；搜狗固定查询 `https://www.sogou.com/web` 并只解析结果标题、摘要与跳转目标；Bing 固定请求 `https://www.bing.com/search?format=rss`。模型不能修改目标主机、请求方法或 header。

搜狗和 Bing 的公开端点都不提供稳定性 SLA，可能限流、调整格式或停止服务。Bing 中国区对部分英文技术查询的相关性较差，因此只作为最后降级路径。正式调研建议配置 Tavily；Provider 实现位于 Adapter Seam，切换时不修改工具调用方、TaskRun 或 TUI。

## 安全模型

- 模型只能提供 `query` 和 `count`，不能控制 URL、HTTP header、请求体或目标主机。
- `web_search` 默认直接执行，不为每条查询弹出审批。使用者仍可通过 `/permissions` 将工具改为 `ask` 或 `deny`。
- 审计记录只保存查询的字节数和 SHA-256，不保存查询正文。
- 查询不得包含凭据、secret、私有源代码或个人数据。
- 每个 Provider 的请求超时为 10 秒；多级降级的总耗时可能更长。单个响应体上限为 1 MiB，模型可见结果上限为 10 条。
- HTML、JSON 和 RSS 均使用有界文本解析；RSS 不展开 DTD 或外部实体。
- 只接受 HTTP(S) 结果 URL，并移除 URL 中的用户名和密码。
- 标题和摘要会被清理、截断，并明确标记为不可信外部证据。模型不得把网页内容当作指令。

成功查询会在当前 TaskRun 中增加 `network_search` 证据和 `networkQueries` 指标。普通工具审计和结果证据仍会同时记录。
