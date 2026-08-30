# 元认知控制与演进设计

## 状态

本文定义 Logos Agent 从“可观察执行”走向“可评价、可纠错、可演进”的目标架构。P0 的持久 ExecutionJournal、可恢复的 execution/TaskRun 关联、私有 canonical trajectory compiler 和 OTel executionId/runId 关联已经实现；P1 的冻结确定性 rubric、证据引用评价和 failure→regression case seed 也已实现。P2–P5 仍是目标设计，不表示语义 judge、在线控制或自动晋级已经启用。

设计结论：元认知不是让执行模型自由反思，而是建立一条由外部证据约束的闭环：

```text
运行事实
  -> 规范化轨迹
  -> 可引用证据的评价
  -> 有限且可审计的控制动作
  -> 跨任务实验与版本晋级
```

轨迹、埋点和 rubric 只提供学习基础设施。只有评价产生了可观察后果，系统才具备元认知控制；只有多个任务上的结果能够选择下一版本策略，系统才具备元认知演进。

## 要解决的问题

### 1. 假完成

当前 `TaskRun` 的 `success` 表示执行流程正常结束，不证明用户目标已经满足。`task-eval.ts` 的 correctness 只比较终态 conclusion，不能判断代码、产物或最终声明的语义正确性。当前 assurance 也只记录验证证据强度，不参与完成决策。

需要区分：

- 执行是否正常结束；
- 产物是否满足目标；
- 最终声明是否有证据；
- 验证是否覆盖当前工作区状态；
- 无法验证时是否如实表达限制。

### 2. 失败不可归因

只看最终测试或回复，无法区分需求误解、计划遗漏、陈旧证据、工具误用、参数错误、修改错误、验证错误、恢复失败和无证据交付。Session、TaskRun 和 Phoenix 已保存部分事实，但没有统一、稳定、可供评价的轨迹模型。

### 3. 失败不能成为组织经验

生产失败、用户纠正和人工 review 尚未自动形成回归 case。模型、system prompt、工具描述、权限策略或 Context 策略变更后，无法证明旧失败没有复发。

### 4. 计算资源分配盲目

Agent 主要依赖固定 Prompt、固定预算和模型自己的判断决定是否继续搜索、重读、重规划或验证。现有实测任务中，大量 Provider 处理量用于重复历史，而当前源码证据覆盖不足。系统需要根据证据新鲜度、风险、错误和信息增益决定下一步，而不是简单增加反思轮次。

### 5. Agent 版本无法可信比较

单条成功轨迹不能证明某项策略有效，单条失败也不能定位是模型、Prompt、工具还是环境导致。策略晋级需要同任务、同环境、可复现的成对比较。

## 不解决的问题

本设计不承诺：

- 从模型隐藏状态中读取真实思维；
- 保存或评价私有 chain-of-thought；
- 在没有外部证据时创造事实真相；
- 用反思弥补基础模型缺失的能力；
- 用 LLM judge 替代权限、安全策略和确定性验证；
- 让运行中的 Agent 自动改写自己的 system prompt；
- 在初始阶段训练或修改模型权重；
- 把所有任务强制变成长工作流。

## 术语

### 对象层

执行用户任务的 AgentHarness、模型和工具循环。

### 监控

从对象层取得运行事实，例如目标、工具调用、变更、验证、耗时、Token、错误和用户介入。

### 评价

使用冻结的 rubric，把轨迹和产物映射为带证据引用的结构化判断。评价不能直接产生副作用。

### 控制

根据评价选择有限动作，例如继续、重新获取证据、验证、重规划、询问用户、停止或交付。

### 演进

在多个版本和多个任务之间，通过离线实验选择 Prompt、工具描述、Context 策略或控制策略。演进对象是版本化策略，不是一次运行中的自由文本自改写。

## 核心不变量

1. Session 保存完整对话和工具事实；Provider Context 只是受预算的工作集。
2. TaskRun 保存执行状态和证据索引；它不自行宣称语义正确。
3. OpenTelemetry/Phoenix 用于运行诊断，可以采样或丢失，不能成为规范轨迹的唯一来源。
4. Rubric 在评价候选轨迹之前冻结，不能根据候选输出反向定制。
5. 每个评价结论必须引用可定位的轨迹步骤或产物证据；无证据时返回 unknown，不能编造理由。
6. 确定性事实优先于 LLM 判断，LLM judge 不能覆盖真实 exit code、权限结果或工作区指纹。
7. 评价与执行副作用分离。Evaluator 返回判断，运行时决定是否以及如何执行控制动作。
8. 在线控制只使用预定义动作并受预算和循环上限约束。
9. 在线运行不修改当前策略版本。策略变化只经过离线回放、比较、晋级和回滚。
10. 原始思维内容不是评价必需数据。只采集外部可观察行为、显式声明和产物。
11. 任何新增门禁必须由重复失败数据、可接受的误拦截率和回放结果支持。
12. 评价失败不得破坏普通 Agent 执行；影子评价默认 fail-open，安全策略仍独立 fail-closed。

## 当前基础与缺口

| 能力 | 当前实现 | 缺口 |
|---|---|---|
| 执行循环 | AgentHarness、completion loop、工具系统 | 不需要新增元认知循环 |
| 持久事实 | Session、ExecutionJournal、TaskRun event journal、private-v1 轨迹投影 | 缺少经授权的跨 Session 导出 |
| 运行诊断 | Phoenix turn/LLM/tool spans，稳定关联 execution/run | 不能作为规范数据；允许采样和丢失 |
| 事实引导 | reflection guidance、assurance | 同上下文自评；评价后果弱 |
| 确定性 Eval | 冻结 rubric、canonical evidence refs、hard fail/unknown、budget、failure case seed | 未接入产物 oracle；语义正确性无确定性准则时保持 unknown |
| Context 治理 | ContextManager 第一阶段 | 尚未根据任务状态和证据生命周期完整投影 |
| 版本身份 | TaskRun manifest hashes | 缺少候选策略、实验和晋级记录 |

## 目标架构

```text
Session / TaskRun / workspace / OTel
                |
                v
        TrajectoryCompiler
                |
                v
 CanonicalTrajectoryRecord v1
     + TelemetryAttachment
           /            \
          v              v
 DeterministicGrader   SemanticJudge
          \              /
           v            v
          TrajectoryEvaluator
                  |
                  v
          EvaluationReport
             /          \
            v            v
  OnlineControlPolicy   OfflineExperimentRunner
            |            |
            v            v
  bounded intervention  PromotionDecision
```

### 为什么分成四个深 Module

#### TrajectoryCompiler

Interface：给定一次 execution，返回规范化、版本化、脱敏的 `TrajectoryBundle`；其中规范轨迹与可选 telemetry 附件具有独立 identity。

Implementation 隐藏 Session/TaskRun 合并、顺序恢复、重复事件消除、产物引用、内容边界、工作区指纹、OTel 关联和 schema migration。删除该 Module 后，这些规则会重新散到 eval runner、Phoenix exporter、TUI 和数据脚本中，因此具有实际深度。

#### TrajectoryEvaluator

Interface：给定冻结 rubric 和轨迹，返回一个 `EvaluationReport`。

Implementation 隐藏确定性 grader、语义 judge、证据校验、unknown 传播、分数校准、judge 重试和报告合成。调用方不需要理解每个 grader 的协议。

#### OnlineControlPolicy

Interface：给定 checkpoint 和 evaluation，返回一个无副作用的 `ControlDecision`。

Implementation 隐藏风险分级、干预预算、循环检测和准入规则。运行时继续拥有工具、队列、审批和停止语义。

#### OfflineExperimentRunner

Interface：给定 baseline、candidate 和冻结 suite，返回 `PromotionDecision`。

Implementation 隐藏重复运行、配对比较、失败聚类、指标置信区间、回归门禁和报告。它永远不直接修改生产配置。

## 身份与关联

一次用户输入从 prompt 开始就需要稳定的 `executionId`，不能等待 TaskRun promotion：

- `executionId`：一次用户目标的规范身份，在 prompt 开始创建；
- `sessionId`：对话树身份；
- `runId`：发生执行任务 promotion 后的 TaskRun 身份，可选；
- `traceId`：OTel 诊断身份，可选且不可作为规范主键；
- `strategyVersion`：完整策略包版本；
- `rubricVersion`：冻结 rubric 版本；
- `evaluationId`：一次评价运行身份。

TaskRun promotion 前发生的 Provider 请求、读取、问题询问和工具决策继续属于同一个 execution。promotion 后只附加 `runId`，不能创建第二条轨迹。

`executionId` 复用 `code-map-roadmap.md` 规划的 prompt/turn correlation identity，不再引入并行的 `turnId`。它必须在第一次 Provider 请求或工具决策之前写入 Session 的非模型可见 lifecycle entry；结束、异常和进程恢复也通过追加 entry 表达。这样即使没有 TaskRun、没有 OTel 或进程中途退出，编译器仍能确定轨迹范围。Logos Agent 当前串行处理 prompt，因此 lifecycle entry 可以界定活动分支上的消息区间；未来若支持并发，每条规范事件必须显式携带 executionId，不能再依赖区间推断。

### ExecutionJournal

P0 首先建立持久 `ExecutionJournal`，而不是只生成一个内存 ID。它使用 Session 的非模型可见 custom entries 追加以下事件：

```typescript
type ExecutionJournalEvent =
	| {
			type: "started";
			executionId: string;
			sessionId: string;
			branchParentEntryId: string | null;
			strategy: StrategyIdentity;
			startedAt: string;
	  }
	| {
			type: "session_entry_linked";
			executionId: string;
			entryId: string;
			role: "user" | "assistant" | "tool_result";
	  }
	| {
			type: "fact_recorded";
			executionId: string;
			evidence: TaskRunEvidence;
	  }
	| {
			type: "task_run_linked";
			executionId: string;
			runId: string;
	  }
	| {
			type: "finished";
			executionId: string;
			outcome: TrajectoryOutcome;
			lastEntryId: string;
			finishedAt: string;
	  };
```

约束：

- `started` 在首个 Provider 请求、工具决策或用户问题发布前持久化；
- pre-promotion 事实通过单条 `fact_recorded` 立即写入 Session，不能只停留在内存缓冲；
- TaskRun promotion 只追加 `task_run_linked`，并在 TaskRun start event 中保存 executionId；
- read-only turn、promotion 前失败和崩溃恢复也保留 execution；
- compiler 只读取从 `branchParentEntryId` 到 `lastEntryId` 的活动分支及显式链接事实，不扫描同 Session 的其他分支猜测归属；
- 没有 `finished` 的 execution 编译为 active/partial，不伪造终态；
- 进程启动和 Session 切换时，上一进程遗留的 active execution 及其 TaskRun 以追加事件恢复为 aborted，不永久伪装成仍在运行；
- journal event 自身版本化、连续编号并支持 idempotency key。

任务要求需要保留来源与权威顺序。用户明确要求优先于模型生成项；workspace instructions 只在其作用域内生效；test oracle 证明可执行结果但不能自行扩大用户目标；generated requirement 默认 `required=false`，未经用户确认或确定性规则提升，不得生成 hard criterion。来源冲突必须保留为诊断信息，不能由编译器静默选择。

## 规范轨迹模型

以下类型描述完整目标 Interface；P0 已实现其中的 private-v1 observe-only 子集：

```typescript
type TrajectoryOutcome =
	| "completed"
	| "failed"
	| "aborted"
	| "timed_out";

type TrajectoryStatus = "active" | "terminal";

interface TrajectoryBundle {
	canonical: CanonicalTrajectoryRecordV1;
	telemetry?: TelemetryAttachmentV1;
}

interface CanonicalTrajectoryRecordV1 {
	schemaVersion: 1;
	compilerVersion: string;
	projectionVersion: string;
	projectionDomainId: string;
	digestScheme: "sha256" | "hmac_sha256";
	digestKeyVersion?: string;
	executionId: string;
	sessionId: string;
	runId?: string;
	strategy: StrategyIdentity;
	task: TaskDefinition;
	contentIndex: readonly ContentReference[];
	steps: readonly TrajectoryStep[];
	evidenceIndex: readonly EvidenceReference[];
	coverage: readonly CoverageAttestation[];
	artifacts: readonly ArtifactReference[];
	completeness: TrajectoryCompleteness;
	status: TrajectoryStatus;
	outcome?: TrajectoryOutcome;
	sourceSnapshotDigest: string;
	trajectoryDigest: string;
	startedAt: string;
	completedAt?: string;
}

interface TelemetryAttachmentV1 {
	schemaVersion: 1;
	executionId: string;
	canonicalTrajectoryDigest: string;
	traceIds: readonly string[];
	measurements: readonly TelemetryMeasurement[];
	completeness: "complete" | "partial" | "absent";
	telemetrySnapshotDigest: string;
}

interface TelemetryMeasurement {
	canonicalStepId?: string;
	spanId: string;
	durationMs?: number;
	usage?: Readonly<Record<string, number>>;
}

interface StrategyIdentity {
	version: string;
	release: string;
	commit?: string;
	features: readonly string[];
	api: string;
	provider: string;
	model: string;
	modelRevision: string;
	providerBuild?: string;
	thinkingLevel: string;
	systemPromptHash: string;
	toolsHash: string;
	policyHash: string;
	contextPolicyHash: string;
	streamOptionsHash: string;
	budgetHash: string;
}

interface TaskDefinition {
	originalGoalRef: string;
	constraints: readonly TaskRequirement[];
	acceptanceCriteria: readonly TaskRequirement[];
	category?: string;
}

interface TaskRequirement {
	id: string;
	statementRef: string;
	source: "user" | "workspace_instruction" | "test_oracle" | "generated";
	required: boolean;
}

interface ContentReference {
	id: string;
	digest: string;
	digestScheme: "sha256" | "hmac_sha256";
	storage: "session" | "artifact_store";
	sourceId: string;
	available: boolean;
	safeSummary?: string;
	sensitivity: "public" | "workspace_private" | "user_private" | "secret";
	exportPolicy: "deny" | "local_only" | "approved_external";
}

interface TrajectoryStep {
	id: string;
	sequence: number;
	phase: "discover" | "execute" | "verify" | "deliver";
	kind:
		| "model_request"
		| "assistant_message"
		| "tool_decision"
		| "tool_result"
		| "workspace_change"
		| "verification"
		| "approval"
		| "user_input"
		| "checkpoint";
	name?: string;
	outcome:
		| "started"
		| "allowed"
		| "blocked"
		| "passed"
		| "failed"
		| "approved"
		| "rejected"
		| "completed"
		| "aborted";
	evidenceRefs: readonly string[];
	subjectFingerprint?: string;
}

interface ArtifactReference {
	id: string;
	kind: "workspace" | "diff" | "command_output" | "test_report" | "final_answer";
	digest: string;
	digestScheme: "sha256" | "hmac_sha256";
	locator: LogicalLocator;
	evidenceRef: string;
	sensitive: boolean;
	exportPolicy: "deny" | "local_only" | "approved_external";
}

interface LogicalLocator {
	kind: "session_entry" | "task_run_event" | "workspace_relative" | "artifact_id";
	value: string;
}

interface EvidenceReference {
	id: string;
	source: "session_entry" | "task_run_event" | "artifact";
	sourceId: string;
	digest: string;
	digestScheme: "sha256" | "hmac_sha256";
	locator?: LogicalLocator;
	available: boolean;
	sensitive: boolean;
	exportPolicy: "deny" | "local_only" | "approved_external";
}

interface TrajectoryCompleteness {
	canonicalFacts: "complete" | "partial";
	missingSources: readonly string[];
}

interface CoverageAttestation {
	capability: "filesystem" | "process" | "network" | "approval" | "external_mutation";
	status: "complete" | "partial" | "unknown";
	enforcementVersion: string;
	evidenceRefs: readonly string[];
}
```

`status=terminal` 时必须同时存在 outcome 和 completedAt；`status=active` 时二者必须省略。在线 checkpoint 使用 active record，离线评价和版本比较使用 terminal record。

所有 `evidenceRefs` 和 `ArtifactReference.evidenceRef` 必须解析到同一条 `evidenceIndex` 记录。Canonical compiler 只合并显式属于该 execution 的 ExecutionJournal events、有效分支 linked entries 和关联 TaskRun events；无关的后续 turn、兄弟分支和 custom entries 不得改变已完成轨迹的 digest。规范步骤顺序由 source-local sequence 和 Execution→TaskRun 因果锚点确定，timestamp 只用于诊断，不能参与规范排序。证据缺失、digest 不匹配或 `available=false` 时，依赖该证据的 criterion 只能得到 unknown。OTel 只进入 `TelemetryAttachmentV1`，不能成为 rubric 或在线控制 evidence；任何影响正确性、安全或任务完成晋级判断的事实都必须回链到 Session、TaskRun 或已做 digest 的 artifact。成本/时延护栏可以使用两侧覆盖一致的 telemetry attachment；缺失或覆盖不对称时该护栏为 inconclusive，不能当作通过。OTel 缺失不改变规范轨迹。

`TaskDefinition` 不保存 Prompt 原文。`originalGoalRef`、`statementRef` 必须解析到 `contentIndex`；默认只暴露有长度上限且经过脱敏的 safeSummary。`ContentReference.sourceId` 和 `LogicalLocator.value` 按 kind 验证：workspace path 必须是规范化相对路径，Session/TaskRun/Artifact 只能使用不含机器路径的 opaque ID。

TrajectoryCompiler 提供 `private` 与 `export_safe` 两种投影。Evidence 继承来源中最严格的 export policy；后者把 `deny`/`local_only` content ref 替换为 `available=false` 的结构化占位符，删除相关 artifact/evidence 和未获批准字段，并重映射 content/artifact/evidence/trace/span IDs。占位符只对固定的 redaction token 做目标域 HMAC，不携带原内容 digest；任何依赖它的评价为 unknown，且所有保留引用仍满足 referential integrity。

private 投影对 secret 和其他低熵私有内容使用本机密钥 HMAC；export-safe 投影使用目标域专属密钥重新计算所有可见 digest、`sourceSnapshotDigest` 和 `trajectoryDigest`，不能暴露 private digest。`projectionDomainId` 只标识不含目标身份的 opaque key domain；相同目标域内可去重，不同导出目标之间不可关联。Telemetry 默认不导出；获批时也必须重映射 ID 并绑定 export-safe trajectory digest。字段级 export policy 由 compiler 强制，调用方不能绕过。

### 轨迹不是事件副本

规范轨迹是由原始事实投影出的评价视图：

- Session 和 TaskRun 继续保存规范原始记录；
- TrajectoryCompiler 负责合并和投影；
- 大内容只保存引用、digest 和安全摘要，不复制到每个 step；
- OTel 提供时延和 Token 等补充事实，缺失时轨迹仍可生成；
- 编译结果带 schema version，可从相同原始记录重复生成；
- evaluator 只读取轨迹和显式产物，不读取执行模型未公开的隐式状态。

### 确定性编译规则

`trajectoryDigest` 只有在编译规则本身也被冻结时才有意义。TrajectoryCompiler v1 必须满足：

- `sourceSnapshotDigest` 覆盖 ExecutionJournal、被链接的 Session entries、TaskRun events 和 artifact digests；
- 规范事件先按 source-local sequence 排序，再按显式因果链接合并；时间戳只用于诊断，不能决定规范顺序；
- 相同 source ID 与 digest 的重复记录折叠；相同 source ID 出现不同 digest 时标记 `partial` 并产生 compiler error，不能静默选一条；
- step、content、evidence 和 artifact ID 由规范 source identity 与 schema version 确定性派生；
- digest 输入使用固定 Unicode/换行规范、字典序 key、稳定数组顺序和明确的缺省值表示；
- `compilerVersion` 固定合并、去重和迁移算法，`projectionVersion` 固定 `private`/`export_safe` 字段投影；
- `trajectoryDigest` 排除 OTel、采集时间和其他可选 telemetry；附件基于冻结的 telemetry snapshot 单独计算 `telemetrySnapshotDigest`；
- 相同 source snapshot、compiler version、projection version、projection domain 和 digest key version 必须得到逐字节相同的 `CanonicalTrajectoryRecordV1` JSON；附件的确定性只对相同 telemetry snapshot 成立。

compiler error 是轨迹数据，不是日志旁注。它进入 `TrajectoryCompleteness.missingSources` 或专用 diagnostics，并使依赖冲突事实的 criterion 返回 unknown。

### 工作区状态要求

当前 subject fingerprint 主要由受控编辑证据递增计算。若命令、外部进程或未覆盖工具也可能修改工作区，仅凭该链不能证明验证覆盖真实当前状态。

在允许 assurance 进入硬判据前，需要满足至少一项：

1. 所有可变更工作区的工具都产生 before/after mutation evidence；或
2. 验证前后通过 workspace adapter 计算实际状态 fingerprint；或
3. 明确把未覆盖的 mutation path 标记为 unknown，使 verified 无法成立。

## Rubric 模型

### 三层结构

以下“硬判据”是语义简称，在 schema 中明确表示为 `required=true`、`decisionRole=gate`、`evaluatorKind=deterministic`，不再用单一 `kind` 字段混合来源、重要性和评价方式。

#### 确定性硬判据

来自用户明确要求、环境状态和工具事实，例如：

- 禁止的副作用没有发生；
- 必需验证命令 exit code 为 0；
- 验证 fingerprint 与当前 workspace 一致；
- 目标文件或产物存在；
- 用户指定格式、范围和约束得到满足；
- 最终声明引用的验证确实执行过。

#### 稳定过程维度

跨 Coding Task 复用，但默认不作为硬门禁：

- End Result；
- Instruction Compliance；
- Evidence Grounding；
- Tool Appropriateness；
- Error Recovery；
- Resource Regulation；
- User Experience。

#### 任务自适应原子准则

从用户原始目标、workspace instructions 和测试 oracle 生成。生成过程只能看任务定义和参考环境，不能看被评价候选的回复、轨迹或策略身份。

LLM 生成的准则只能分解或澄清已有要求，不能增加用户没有提出的功能、风格或验证义务。无法追溯到 `TaskRequirement.id` 的生成准则不得成为 hard criterion。

### Criterion 结构

```typescript
type CriterionResult = "pass" | "fail" | "unknown" | "not_applicable";

interface RubricCriterion {
	id: string;
	name: string;
	description: string;
	dimension: "completion" | "semantic_correctness" | "verification" | "safety" | "efficiency" | "process";
	scope: "global" | "task_specific";
	required: boolean;
	decisionRole: "gate" | "diagnostic";
	evaluatorKind: "deterministic" | "semantic" | "human";
	scoring: "binary" | "ordinal";
	scoreDomain: readonly number[];
	anchors: readonly RubricAnchor[];
	evidencePredicate: EvidencePredicate;
}

type EvidencePredicate =
	| {
			kind: "execution_completed";
			allowedOutcomes: readonly TrajectoryOutcome[];
	  }
	| {
			kind: "step_observed";
			stepKind: TrajectoryStep["kind"];
			outcomes?: readonly TrajectoryStep["outcome"][];
			minimumCount?: number;
			requireCurrentSubject?: boolean;
	  }
	| { kind: "current_subject_verified" }
	| { kind: "budget_within"; budget: TaskRunBudget }
	| {
			kind: "command_succeeded";
			commandSpecDigest: string;
			requireCurrentSubject: boolean;
	  }
	| {
			kind: "artifact_matches";
			artifactKind: ArtifactReference["kind"];
			constraintDigest: string;
	  }
	| {
			kind: "claim_grounded";
			claimClass: string;
	  }
	| {
			kind: "capability_absent";
			capability: CoverageAttestation["capability"];
			forbiddenEventClass: string;
	  }
	| {
			kind: "semantic_satisfaction";
			requirementIds: readonly string[];
	  };

interface RubricDefinition {
	schemaVersion: 1;
	version: string;
	taskDigest: string;
	projectionDomainId: string;
	digestScheme: "hmac_sha256";
	digestKeyVersion: string;
	rubricDigest: string;
	generatedBy: "human" | "deterministic" | "llm";
	generatorVersion: string;
	frozenAt: string;
	criteria: readonly RubricCriterion[];
}

interface RubricAnchor {
	score: number;
	description: string;
}

interface CriterionEvaluation {
	criterionId: string;
	result: CriterionResult;
	score?: number;
	confidence?: number;
	evidenceRefs: readonly string[];
	explanation: string;
	evaluator: string;
}

interface EvaluationReport {
	evaluationId: string;
	executionId: string;
	reportDigest: string;
	digestScheme: "sha256" | "hmac_sha256";
	digestKeyVersion?: string;
	rubricVersion: string;
	rubricDigest: string;
	trajectoryDigest: string;
	sourceSnapshotDigest: string;
	compilerVersion: string;
	projectionVersion: string;
	projectionDomainId: string;
	artifactSnapshotDigests: readonly string[];
	deterministicGraderVersion: string;
	judgeVersion?: string;
	judgeConfigHash?: string;
	status: "completed" | "partial" | "failed";
	criteria: readonly CriterionEvaluation[];
	hardDecision: "pass" | "fail" | "unknown";
	diagnostics: readonly FailureDiagnostic[];
	errors: readonly string[];
	startedAt: string;
	completedAt: string;
}

interface FailureDiagnostic {
	code: string;
	criterionIds: readonly string[];
	evidenceRefs: readonly string[];
	description: string;
}
```

`EvaluationReport` 必须与输入轨迹处于同一 projection domain。private report 不能直接导出；export-safe report 必须从 export-safe trajectory/rubric 重评或重新投影并重算 report、rubric、artifact 和 trajectory digests，禁止混用两个 domain 的引用。

### 合成规则

- 只有 `required=true && decisionRole=gate && evaluatorKind=deterministic` 的 criterion 能影响 `hardDecision`；
- 任一上述 criterion 为 fail，则 `hardDecision=fail`；
- 没有 fail 但任一上述 criterion 为 unknown，则 `hardDecision=unknown`；
- 所有适用 gate criteria 为 pass，才得到 `hardDecision=pass`；
- 没有任何适用的 deterministic gate 时，`hardDecision=unknown`，不能用空集合推出任务正确；
- semantic/human criterion 即使 required，也先保持 diagnostic，直到存在独立高精度 deterministic oracle；
- process 和 task-specific 分数保持为向量，不默认压成单一加权总分；
- 高分维度不能抵消安全、正确性或明确指令上的失败；
- `not_applicable` 必须说明为什么不适用；
- explanation 中出现但 evidenceRefs 未引用的事实不参与判断。
- `evidencePredicate` 描述需要什么事实，不引用某次运行的具体 evidence ID；匹配出的 ID 只写入 `CriterionEvaluation.evidenceRefs`；
- 否定判据只有在对应 `CoverageAttestation.status=complete` 时才能因“未观察到事件”得到 pass；partial/unknown coverage 一律传播为 unknown；
- ordinal anchors 的 score 必须唯一、严格递增且覆盖声明的 score domain；`confidence` 取 `[0,1]`，只表达 evaluator 校准置信度，不能改变确定性 gate 结果。

## Evaluator 可信度

### 确定性 grader 优先

能由文件、结构化工具结果、exit code、schema 或 fingerprint 判断的事实，不交给 LLM judge。

### 语义 judge 处于独立上下文

语义 judge 读取：

- 冻结任务和 rubric；
- 规范轨迹；
- 必需产物；
- 可用工具和执行约束。

它不读取：

- 执行模型身份和展示名称；
- 候选策略的人类标签；
- baseline/candidate 顺序；
- 执行模型的私有 chain-of-thought；
- 先前 judge 的结论。

### 校准与弃权

- 语义 judge 首先在 shadow mode 运行；
- 使用双人或仲裁后的人类 gold set 计算逐 criterion 一致性；
- 对 pairwise review 随机交换左右顺序；
- 记录 judge 版本、温度、Prompt hash 和重复采样结果；
- 证据不足或重复结果分歧时返回 unknown；
- 未达到预注册一致性标准的 criterion 不得进入在线门禁；
- 同模型家族自偏好需要单独测量，不能只看总体相关系数。

## 在线控制

### 允许的动作

```typescript
type ControlAction =
	| "continue"
	| "reacquire_evidence"
	| "verify"
	| "replan"
	| "ask_user"
	| "stop_unverified"
	| "deliver";

interface ControlCheckpoint {
	executionId: string;
	sequence: number;
	trajectoryDigest: string;
	subjectFingerprint: string;
	userInputSequence: number;
	planVersion: number;
	evidenceFingerprint: string;
}

interface ControlBudgetSnapshot {
	executionId: string;
	policyVersion: string;
	maxTotalInterventions: number;
	consumedInterventions: number;
	perActionLimit: Readonly<Partial<Record<ControlAction, number>>>;
	consumedByAction: Readonly<Partial<Record<ControlAction, number>>>;
}

interface ControlDecision {
	decisionId: string;
	evaluationId: string;
	checkpoint: ControlCheckpoint;
	loopKey: string;
	policyVersion: string;
	mode: "observe_only" | "advisory" | "soft_control" | "hard_gate";
	action: ControlAction;
	reasonCodes: readonly string[];
	evidenceRefs: readonly string[];
}

type ControlJournalEvent =
	| {
			type: "accepted";
			decision: ControlDecision;
			budgetAfter: ControlBudgetSnapshot;
			acceptedAt: string;
	  }
	| { type: "started"; decisionId: string; attempt: number; startedAt: string }
	| {
			type: "finished";
			decisionId: string;
			resultEvidenceRefs: readonly string[];
			finishedAt: string;
	  }
	| {
			type: "abandoned";
			decisionId: string;
			reason: "stale" | "result_unknown" | "adapter_rejected";
			abandonedAt: string;
	  };
```

Evaluator 不能直接调用工具。运行时将 `ControlDecision` 映射到现有 Harness、工具、用户问题或停止协议。

干预预算由运行时持有，Policy 只能读取 `ControlBudgetSnapshot`，不能通过 decision 自报剩余额度。运行时必须以原子操作接受 decision：检查 execution、完整 checkpoint、policy version、未消费 decisionId、未消费 loopKey 以及总量/分动作预算，然后同时登记消费并排队动作。任一检查失败都不得执行部分副作用。

工作区 fingerprint、用户输入序号、计划版本、evidence fingerprint 或轨迹 digest 在评价后发生变化时，旧 decision 失效，必须重新编译 checkpoint。相同 execution 中 replay decision、并发消费或相同 loopKey 重复动作只能有一个成功；用户 steer 到达时，所有基于更早 `userInputSequence` 的待执行 decision 失效。

### 持久控制 journal 与恢复

原子接受不是只改内存：运行时以 expected journal version 做 compare-and-append，一次写入包含 decision 与 `budgetAfter` 的 `accepted`；该记录本身就是 durable outbox item，预算和 loopKey ledger 都从 journal 派生。只有 durable append 成功后 worker 才能执行动作，并发写入者只有一个能成功。动作 adapter 接收 `decisionId` 作为 idempotency key，并在副作用前后写入 `started`/`finished`。

进程恢复时从 journal 重建预算和已消费 loopKey：

- `accepted` 但未 `started`：checkpoint 仍有效才重新排队，否则记 `abandoned/stale`；
- `started` 但未 `finished`：只有 adapter 能按 idempotency key 查询结果或保证幂等重放时才恢复；
- 无法确认外部副作用结果：记 `abandoned/result_unknown`，停止自动重放并询问用户或人工处理；
- `finished` 或 `abandoned`：永不再次执行，也不退还预算。

这提供可恢复的 at-most-once 控制决定；对支持幂等键的 adapter 可以达到一次有效结果，但不声称对任意外部系统提供通用 exactly-once。

### 初始准入顺序

1. `observe_only`：只记录评价，不影响 Agent；
2. `advisory`：把证据和建议反馈给执行模型；
3. `soft_control`：要求重新获取证据或验证，但允许在预算上限后退出；
4. `hard_gate`：只用于高精度、确定性、重复出现的失败模式。

每次 execution 的自动干预次数必须有上限。相同 reason code 和相同 evidence fingerprint 重复出现时，不再启动同一种干预，避免反思死循环。

### 第一批候选控制规则

只考虑可以由现有事实支持的规则：

- 当前 workspace 没有匹配验证，但最终声明声称测试通过；
- 最新当前状态验证失败，却尝试交付 success；
- 修改路径没有当前源码读取证据；
- 用户明确 acceptance criterion 没有任何证据引用；
- 同一工具以相同参数重复失败且没有新信息；
- 检测到任务外 mutation，且模型没有说明或回退。

这些规则先进入 shadow/advisory，不直接成为门禁。

## 离线演进

### 演进对象

允许形成 candidate 的内容：

- system prompt；
- 工具名称、描述和 schema；
- Context 投影策略；
- control policy；
- 模型和 thinking level；
- 任务专用 skill 或 prompt template。

不允许在运行中修改当前版本。候选可以由人或模型提出，但二者经过相同晋级流程。

### StrategyBundle

```typescript
interface StrategyBundle {
	version: string;
	parentVersion?: string;
	changeReason: string;
	release: string;
	commit?: string;
	features: readonly string[];
	api: string;
	provider: string;
	model: string;
	modelRevision: string;
	providerBuild?: string;
	thinkingLevel: string;
	systemPromptHash: string;
	toolsHash: string;
	policyHash: string;
	contextPolicyHash: string;
	streamOptionsHash: string;
	budgetHash: string;
	createdAt: string;
}

interface ExperimentEnvironmentIdentity {
	fixtureRevision: string;
	os: string;
	runtimeVersions: Readonly<Record<string, string>>;
	lockfileDigest: string;
	toolVersionsDigest: string;
	taskNetworkMode: "disabled" | "recorded";
	permissionPolicyDigest: string;
}

interface ExperimentManifest {
	experimentId: string;
	baselineStrategyDigest: string;
	candidateStrategyDigest: string;
	suiteDigest: string;
	rubricDigests: readonly string[];
	judgeConfigHash?: string;
	environment: ExperimentEnvironmentIdentity;
	repetitionsPerVariant: number;
	seeds: readonly number[];
	caseIds: readonly string[];
	frozenAt: string;
}

interface ExperimentResultIndex {
	experimentManifestDigest: string;
	runs: readonly ExperimentRunReference[];
}

interface ExperimentRunReference {
	caseId: string;
	variant: "baseline" | "candidate";
	repetition: number;
	seed: number;
	executionId: string;
	trajectoryDigest: string;
	evaluationDigest: string;
}
```

### 晋级流程

```text
生产失败或改进假设
  -> 形成最小 candidate
  -> 冻结 eval suite 和 rubric
  -> baseline/candidate 同任务配对运行
  -> 确定性结果 + 盲评 trajectory review
  -> 检查正确性、安全、恢复、成本和误拦截
  -> reject / shadow / canary / promote
  -> 保留回滚版本
```

单次 Trace 只能产生假设，不能证明因果。尽量一次只改变一个策略维度；无法隔离时，报告结论只能归因于整个 StrategyBundle。

### PromotionDecision

晋级必须满足：

- 没有新的安全或权限回归；
- hard task success 不劣于 baseline；
- 目标失败模式在冻结 case 上减少；
- judge-human agreement 达到该 criterion 的预注册标准；
- Token、延迟和工具调用开销在接受范围；
- 所有失败 case 有可读、带证据的差异报告；
- candidate、suite、rubric、judge 和环境版本均可重放；
- 存在明确回滚版本。

不得只凭平均总分晋级。

`ExperimentManifest` 在运行前冻结 case IDs；运行生成的 execution IDs 和输出 digests 只追加到 `ExperimentResultIndex`。`PromotionDecision` 必须引用二者、指标估计与置信区间、逐 case 差异、拒绝原因和回滚版本。任一 variant 的 fixture、权限、网络、工具版本、重复次数或样本集合不一致时，runner 拒绝生成可晋级结论。

可晋级实验禁止任务工具访问 live network，只能 disabled 或读取冻结 recording。模型调用必须记录 Provider 给出的不可变 model revision/build；仅有可漂移 alias 时，runner 把实验标为 `non_exact_replay`，按 baseline/candidate 随机交错并按时间块配对，避免把时段漂移直接归因于策略。此类结果只能形成改进假设，不能单独支撑 promote；至少还需要固定 revision 的复验或独立稳定 oracle 上的一致结果。生产 live trace 同样只能成为 case 候选，不能伪称可重放实验。

## 生产反馈如何进入系统

以下信号只能作为弱标签或 case 候选，不能直接当作真值：

- 用户 steer 或纠正；
- 用户要求重做；
- 用户中止或放弃；
- 相同目标的后续修复；
- 工具失败和重试；
- 低 assurance 交付；
- 任务外改动；
- Provider 请求或 Token 异常；
- 人工 review 评论。

进入 eval suite 前需要：

1. 删除敏感内容；
2. 冻结最小 workspace fixture；
3. 明确用户目标和 acceptance criteria；
4. 提供确定性 oracle，或标记需要人工/语义判断；
5. 防止把候选策略看到过的 case 同时作为无污染 holdout。

## 隐私与安全

- 默认轨迹不复制 Prompt、源码、工具全文或 shell 输出；只保存引用、digest、大小和安全摘要；
- 需要内容的评价在本机或明确批准的 Provider 上运行；
- Phoenix 的 content capture 不能自动成为训练数据授权；
- API key、Authorization、Cookie、环境变量、用户身份和绝对路径经过现有安全管道及二次脱敏；
- ArtifactReference 必须标记 sensitive，导出器按目标环境执行 allowlist；
- 轨迹保留期、删除和人工标注权限独立配置；
- 原始 chain-of-thought 不进入轨迹、rubric 或训练集；
- judge 输入中的代码、网页和工具结果继续按不可信数据处理。

## 可观测性

Session 和 TaskRun 是规范持久事实，规范轨迹是可重复生成并可选择持久化的派生记录；OTel 是被动诊断 adapter。建议关联：

- executionId；
- runId；
- strategyVersion；
- rubricVersion；
- evaluationId；
- control action 和 reason code；
- criterion result、score、confidence；
- evidence count 和 unknown count。

评价结果可映射为 `gen_ai.evaluation.result` 类事件，但 OTel 规范变化应集中在 adapter，不泄漏到核心 Interface。

Observability subscriber 的失败不能改变 Agent 结果。在线控制通过显式 `OnlineControlPolicy` seam 进入运行时，不能借用被动 subscriber 偷渡控制逻辑。

## 分阶段实施

### P0：统一身份与规范轨迹（已落地）

- 实现持久 ExecutionJournal；prompt 开始创建 executionId，并在首个 Provider/工具事件前持久化 lifecycle start；
- pre-promotion canonical facts 立即进入 Session，不再只依赖进程内 `pendingTaskRunEvidence`；
- 正常结束、异常和恢复通过追加 lifecycle entry 界定 execution；
- 与 CodeMap 共用同一个 prompt/turn correlation identity；
- TaskRun promotion 后关联 runId；
- OTel span 附加 executionId/runId；
- 实现 TrajectoryCompiler v1；
- 从现有 Session/TaskRun 重放生成轨迹；
- 不改变 Agent 行为。

验收：read-only turn、promotion 前失败、崩溃恢复和分支执行都能界定；相同 source snapshot 在相同 compiler/projection version、projection domain 和 digest key version 下逐字节一致；有无 OTel 得到相同 canonical digest；敏感内容默认不导出。

当前实现位置：`execution-journal.ts` 隐藏事件校验、连续序号、幂等和恢复投影；`session-execution-journal.ts` 是 Session adapter；`trajectory-compiler.ts` 是纯计算 Module。`LogosAgent.getExecutionTrajectory()` 只生成 `private-v1` 投影，使用 `sessionsRoot/.trajectory-hmac-key` 的本地 HMAC key；尚未提供 export-safe 导出器，也不执行控制动作。

### P1：确定性 rubric（已落地）

- 把现有 task-eval 迁移为证据引用的 hard criteria；
- 区分 completed、semantically correct 和 verified；
- 验证 mutation coverage 和 workspace fingerprint；
- 建立 production failure -> eval case 流程；
- 继续离线运行。

验收：每个 hard result 都可定位到原始证据；unknown 不被误报为 pass；旧 case 可稳定重放。

当前实现位置：`trajectory-evaluator.ts` 提供 `freeze()` 和 `evaluate()` 两个 Interface。Rubric 与 canonical trajectory 都使用本地 HMAC 校验，评价前验证 task、projection domain、冻结时间、版本和输入 digest；report 分开给出 completed、semantically correct 和 verified，不用 execution completion 冒充语义正确。当前 compiler 对 filesystem、process 和 external mutation coverage 均保守输出 `unknown`；只有后续 adapter 提供可解析且完整的 coverage attestation，current-subject verification 才能 pass。`task-eval.ts` 可把旧 TaskEval case 转换为冻结 rubric input，并把生产 hard failure 连同 criterion/evidence 引用生成 regression case seed。`LogosAgent.freezeRubric()` 与 `evaluateExecution()` 只提供按需、离线评价，不改变 prompt、工具或交付行为。

### P2：语义轨迹评审

- 实现 task-specific rubric freeze；
- 接入独立 SemanticJudge adapter；
- 建立人类 gold set、盲评、顺序交换和弃权；
- 只在 shadow mode 运行。

验收：逐 criterion 报告 judge-human agreement；未达标 criterion 明确禁用；评价失败不影响任务。

### P3：建议式在线控制

- 在交付前 checkpoint 调用 OnlineControlPolicy；
- 只返回预定义动作；
- 建立 intervention budget 和 loop key；
- 实现持久 ControlJournal、durable outbox 和 adapter idempotency；
- 首批规则限定为证据缺失、验证过期和重复失败。

验收：误拦截、恢复成功率、额外 Provider 请求和额外 Token 均可观测；关闭 feature flag 后行为回到 baseline。

### P4：数据支持的门禁

- 只把高精度确定性规则升级为 hard gate；
- 对每条门禁保存失败样本、误拦截率和启用版本；
- 设置最大干预次数与安全退出；
- 保留人工覆盖和回滚。

验收：冻结 suite 上目标失败显著下降，任务成功不退化，误拦截在预注册范围。

### P5：离线策略演进

- 版本化 StrategyBundle；
- baseline/candidate 成对回放；
- 生成 PromotionDecision；
- 进入 shadow/canary/promote/rollback 流程；
- 不做运行中自改写。

验收：任何生产策略都能追溯到候选、suite、报告和晋级决定；失败可以回滚。

## 最小验证实验

第一项实验只验证“证据化完成判定”，不同时验证整个演进愿景。

### 数据集

先构建至少 60 个冻结 case，每类不少于 15 个：

1. 正确完成且证据充分；
2. 最终声明成功但 acceptance criterion 未满足；
3. 验证通过后又发生修改；
4. 检测到错误后成功恢复或错误交付。

case 必须包含 workspace fixture、原始目标、显式约束、可执行 oracle 或人工 gold，以及完整轨迹。

其中至少 40 个同时存在可重复执行的 baseline/candidate 环境，用于 advisory 对照；其余可用于 grader/judge 校准。每个可执行 case 对每个 variant 至少运行 3 次，使用同一组预注册 seed。case、重复次数、排除条件和缺失数据处理在看到 candidate 结果前写入 `ExperimentManifest`。

### 对照

- Baseline：当前 reflection guidance 和 assurance，只记录不控制；
- Candidate A：规范轨迹 + 确定性 rubric，shadow mode；
- Candidate B：Candidate A + advisory control；
- 暂不加入自动 Prompt 演进。

### 主指标

- false completion rate；
- unsupported final claim rate；
- stale verification detection precision/recall；
- intervention 后恢复成功率；
- 已知失败复发率。

### 护栏指标

- 正确任务被误拦截率；
- hard task success；
- Provider 请求、Token、延迟和工具调用增量；
- 用户问题增量；
- judge-human agreement；
- evaluation failure rate。

### 预注册判定阈值

首轮 pilot 使用以下明确门槛；团队可以在实验开始前修改，但看到 candidate 结果后不得追改：

- Candidate B 的 false completion rate 相对 Baseline 至少降低 30%，且 paired bootstrap 95% CI 的改善下界大于 0；
- stale verification detection precision 不低于 95%，recall 不低于 80%；
- hard task success 的配对差值 95% CI 下界高于 -3 个百分点；
- 正确任务被自动要求额外动作的比例不高于 5%；
- 相对 Baseline，单任务 processed tokens 和 Provider request count 各自的增量中位数不高于 15%，P95 不高于 25%；
- deterministic evaluation failure rate 低于 1%，semantic evaluation failure rate 低于 5%；
- 每个拟用于 advisory 的 semantic criterion 与仲裁后 human gold 的 Cohen's kappa 不低于 0.70。

比例指标按 case 配对计算，区间按 case bootstrap，不把同一 case 的重复运行当作独立样本。若样本量不足以给出上述区间，结论是 inconclusive，不能晋级。任何主指标未达标或护栏越界，都停止在线控制扩展；轨迹和离线评价仍可保留，但不能声称已经实现元认知改进。

## 测试策略

测试通过各 Module 的 Interface，而不是内部 grader 或事件拼接细节。

### TrajectoryCompiler

- 乱序、重复、缺失和 promotion 前事件；
- 无 OTel、多个 trace、被截断 content；
- schema migration；
- deterministic compile；
- 同一规范事实有/无 telemetry 时 canonical JSON 和 digest 不变；
- sensitive artifact/evidence export policy；
- 低熵 secret 的 private digest 不可字典猜测，export-safe 投影不含 private digest，两个 export domain 的 opaque ID/digest 不可关联。

### TrajectoryEvaluator

- hard fail/unknown 传播；
- evidenceRefs 不存在时拒绝采用结论；
- process 高分不能抵消 hard fail；
- judge timeout、malformed output、分歧和弃权；
- rubric 在候选输出前冻结。

### OnlineControlPolicy

- 每个 reason code 的动作；
- 相同 loop key 不重复干预；
- budget 用尽后的安全退出；
- decision replay、并发消费和相同 loopKey 竞争时只有一个动作提交；
- workspace mutation、用户 steer、计划更新或新 evidence 使旧 checkpoint 失效；
- 在 accepted、started 和副作用结果写回点分别注入崩溃，恢复后预算不重置、已知动作不重复、未知外部结果不自动重放；
- feature flag 关闭时无行为变化；
- evaluator 故障 fail-open，安全策略仍独立生效。

### OfflineExperimentRunner

- 同任务配对；
- case 集或环境不一致时拒绝比较；
- live task network 或不可变模型 revision 缺失时拒绝生成可单独晋级的结论；
- 安全回归阻止晋级；
- 平均分提升但 hard task success 下降时拒绝晋级；
- promotion report 可重放。

### 安全与隐私回归

- Prompt、源码、网页和工具输出中的指令不能改变 rubric、judge 协议或 export policy；
- secret、用户身份、绝对路径和 `exportPolicy=deny` 内容不出现在 export-safe projection；
- retention 到期或用户删除后，content reference 不可解析，依赖评价转为 unknown；
- artifact access denied、digest mismatch 和部分读取不能被当作 artifact 不存在或 criterion pass；
- semantic judge 只能访问 manifest allowlist 中的内容和 Provider。

## 端到端示例

用户要求“修复 cache accounting，并运行指定检查 `check-cache`”。编译器把这两个要求分别保存为用户来源的 `TaskRequirement`，rubric 在执行前冻结一个 `command_succeeded` gate，并要求验证绑定当前 subject fingerprint。

第一次执行修改工作区 fingerprint `ws-2`，但引用的 `check-cache` 结果来自修改前的 `ws-1`，最终回复却声明检查通过。确定性 grader 不需要判断代码语义：它把“指定检查通过”判为 fail，引用 workspace change、旧 verification 和 final claim 三条 evidence。Policy 在 advisory 阶段返回一次 `verify`；运行时检查 checkpoint 和预算后原子消费 decision。

第二次 `check-cache` 在 `ws-2` 上通过，新 checkpoint 的 gate 为 pass，允许交付。若用户没有明确要求检查，且没有已登记的确定性项目规则，系统不会凭 LLM 生成一个新的硬测试义务；最多给出 diagnostic 建议。这保留了现有“验证应按任务类型和风险选择”的原则，而不是引入通用测试门禁。

## 成功定义

本设计只有在以下结果被当前状态证据证明后，才算实现成功：

1. 系统能从规范事实重复生成同一条轨迹；
2. 评价能指出哪条准则失败以及对应证据；
3. 无证据判断会明确返回 unknown；
4. 控制动作能减少目标失败，而不是只增加反思文本；
5. 历史失败能稳定变成回归 case；
6. 候选策略只能通过冻结任务集和护栏后晋级；
7. 任何线上策略都可追溯、比较和回滚；
8. 正确率改进不是以安全、成本或用户体验明显退化换取。

在 P0-P2 完成前，应称其为“轨迹评价基础设施”；P3 经实验证明有效后，才称为“元认知控制”；P5 形成可重复晋级闭环后，才称为“元认知演进”。

## 研究依据

- Nelson–Narens 的 monitoring/control 区分，为对象层与元层的信息流提供基础模型；
- Metacognitive Loop 的 note/assess/guide，强调异常、诊断和纠正动作必须闭环；
- Reflexion、Self-Refine 和后续自纠错研究表明语言反馈可提供帮助，但缺少外部证据时不稳定；
- Agent trajectory evaluation 与 task-adaptive rubric 工作支持同时评价最终产物和过程，不把所有任务压成固定 helpfulness 维度；
- OpenTelemetry GenAI semantic conventions 可作为 adapter 的命名参考，但不能替代规范轨迹存储。

相关外部资料：

- <https://ojs.aaai.org/index.php/AAAI/article/view/42135>
- <https://cdn.aaai.org/ocs/2161/2161-9485-1-PB.pdf>
- <https://papers.neurips.cc/paper_files/paper/2023/file/1b44b878bb782e6954cd888628510e90-Paper-Conference.pdf>
- <https://aclanthology.org/2024.tacl-1.78/>
- <https://arxiv.org/abs/2603.21362>
- <https://arxiv.org/abs/2607.06624>
- <https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md>
- <https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-events.md>

相关仓库设计：

- [Agent 架构分类学与反思引导](./agent-architecture.md)
- [TaskRun 与 Eval](./task-run.md)
- [Logos Agent Context 治理方法与设计](./context-governance.md)
- [Logos Agent 可观测性](./observability.md)
