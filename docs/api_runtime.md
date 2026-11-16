# 当前 API 调用与部署流程

核对日期：2026-11-11。本文依据当前 `composition.py`、图片／文本／视频 Provider 和 Worker 实现说明实际调用链。H3、Codex CLI 的旧实现仍可用于兼容与历史恢复，但当前网页新任务使用下列 API 流程。

## 图片：图片 API → 候选文件 → 正式归档

浏览器提交到本站图片任务接口，`WorkbenchState` 校验空间、请求幂等和积分；Worker 领取已受理任务后，由 `TaskRunner` 组织输入快照并调用 `ImageAPIBackend`。

| 输入 | 供应方接口 | 本项目请求与结果约定 |
| --- | --- | --- |
| 纯文字生成 | `POST /v1/images/generations` | 默认配置模型 `gpt-image-2`，每项任务 1 张，返回 `b64_json` |
| 带参考图生成或编辑 | `POST /v1/images/edits` | `images[].image_url` 使用 Data URL，编辑基底排在附加参考图前 |

基础地址通过私密配置提供，不能仅凭模型名推定任意供应方都支持该请求结构。比例 `1:1`／`3:2`／`2:3` 对应请求尺寸 `1024x1024`／`1536x1024`／`1024x1536`；自动比例不发送 `size`。

返回内容先写为候选文件，再通过既有内容、大小、像素、来源和哈希检查，登记到正式存储。图片编辑创建新任务和版本，保留原图。当前站内基础积分为纯文字 40、带参考图或编辑 60，最终以服务端报价和账本为准；供应方 API 费用由其账号承担。

图片 Provider 对代码列明的审核拒绝、429、500／502／503／504 及尚未建立连接的错误，在同一次执行中最多尝试 3 次；正文保持一致，并受总时限及 `Retry-After` 约束。读写超时或传输中断后不会自动重新调用图片 API。恢复归档及结果回传只处理原候选文件。完整协议见 [图片 API 接入](image_api_integration.md)。

## 文本：DeepSeek Flash

当前全站装配使用 `DeepSeekModelRegistry` 和 `DeepSeekTextAdapter`。脚本／剧本、分镜规划和 SD2.0 提示词规划使用 `deepseek-flash`，代码中的文本端点为 `https://api.deepseek.com/chat/completions`，思考档位为 `low`／`high`／`max`。

模型和站内价格分别由 `config/deepseek/script_models.json`、`script_pricing.json`、`script_routing.json` 及 `storyboard_pricing.json` 管理。当前配置的免费站内档位仍经过既有任务和结算规则，不意味着供应方 API 没有费用。

本地网页由应用服务调用文本适配器；`cloud` 模式的脚本任务交给 `ScriptRemoteWorker`，它也使用 DeepSeek API。分镜由 `StoryboardService` 与 `StoryboardPlanner` 协调，独立于图片生成队列。模型可用性来自 API 配置及脚本执行器的实际能力，不读取本机 Codex 模型缓存作为当前文本能力目录。

文本调用开始前保存 `request.json`，成功后保存 `response.txt` 和 `completed.json`，记录输入摘要、结果哈希与供应方回执。恢复时核对原回执；连接中断或结果不确定时不会自动再发一遍生成请求。

AI 强化使用独立的 `DeepSeekFlashClient`，默认同样调用 DeepSeek Flash。`config/prompt_enhancement.json` 指定 Provider、Skill、长度和调用上限；`config/script_routing.json` 的 `deepseek_flash` 段允许通过 `SCRIPT_DEEPSEEK_ENDPOINT`、`SCRIPT_DEEPSEEK_MODEL`、`SCRIPT_DEEPSEEK_API_KEY` 覆盖这条轻量调用路径。未覆盖时复用现有 DeepSeek 端点、模型和密钥。点击“使用强化版”只回填文字，不提交图片或变动站内积分。

## 视频：规划 → SD2.0 提交 → 轮询与回传

网页按图片、脚本、分镜审核、视频四步组织。`composition.py` 对新视频任务只启用 `online-2.0`；当前接入能力为 720p T2V、5／10／15 秒、横屏／竖屏／方形。`VideoStore.create_shot` 会拒绝 SD2.0 的 1080p 或带参考图请求，即使全站启用了 1080p 配置也不例外。

1. 用户确认镜头及报价，`VideoStore` 保存作业并通过现有账本冻结积分。
2. `OnlineVideoPlanner` 领取 `planning` 阶段任务，使用 `seedance-2-video` Skill 和 DeepSeek Flash 整理提示词；完成后进入视频生成队列。
3. `OnlineVideoWorker` 写入持久提交日志，再调用 `https://ai-genvideo.com/v1/videos/generations`，发送 `prompt`、`mode: "2.0"`、`ratio`、`durationSeconds`。
4. 成功取得供应商 `id` 后，按同一任务号查询 `GET /v1/tasks/{id}`。需要重新取得结果地址时调用 `GET /v1/tasks/output-url/{id}`，不重新提交生成。
5. 下载并校验 MP4，使用 FFmpeg 按本站 720p 交付宽高缩放／补边，保存输出及哈希，再回传、归档和结算。这里的交付尺寸不等同于向供应方请求原生同分辨率生成。

当前实现提交后先等待 300 秒再查询供应商状态，主循环间隔 30 秒；网页的规划／生成状态和经过时间不是供应方进度百分比。输出上限为 40 MiB，视频处理需要 FFmpeg／ffprobe。

提交超时、回执缺少任务号或无法确认是否受理时进入 `uncertain`，不重复提交。明确未受理的容量拒绝（503、`QUOTA_EXCEEDED`、指定“当前算力已满”消息且无任务 ID）按失败结算并释放冻结；不能把所有 5xx 都当作未受理。

尚未领取且没有有效 claim 的排队任务可取消；重复取消不会重复退款。未知结果需先核对原 Worker、attempt、供应商任务号和输出。管理员填写核对依据后才能确认停止并释放冻结；已存在输出时先恢复归档。网页操作不终止外部供应商任务。

## 配置与启动入口

| 配置 | 用途 |
| --- | --- |
| `IMAGE_WORKBENCH_IMAGE_API_CONFIG` | 私密 JSON：`base_url`、`api_key`、`model` |
| `IMAGE_WORKBENCH_IMAGE_API_BASE_URL`、`IMAGE_WORKBENCH_IMAGE_API_KEY`、`IMAGE_WORKBENCH_IMAGE_API_MODEL` | 分别覆盖图片配置文件中的地址、密钥和模型 |
| `DEEPSEEK_API_KEY` | 文本 API 密钥，优先于下列配置文件 |
| `IMAGE_WORKBENCH_TEXT_API_CONFIG` | 含 `api_key` 的私密 JSON，供文本服务与 Worker 读取 |
| `IMAGE_WORKBENCH_PUBLIC_ORIGIN` | 本站公开 HTTPS 源站 |
| `IMAGE_WORKBENCH_WORKER_TOKEN` | 本站执行器认证令牌，不是供应方 Key |
| `IMAGE_WORKBENCH_IMAGE_BACKEND=image-api` | `cloud` 入口选择图片 API；本地 `web`／`worker` 显式传 `--backend image-api` |
| `IMAGE_WORKBENCH_ONLINE_VIDEO_CONFIG` | 视频执行器私密 JSON 的路径 |

供应方凭据由实际调用进程读取，不发送到浏览器。`deploy/*.local.json` 已被 Git 忽略；服务器私密配置使用受限文件权限。API 地址、密钥和 Worker 令牌应使用自己的有效配置。

`web` 入口不开放远程 Worker 接口。需要文本/视频执行器领取任务时，网站使用 `cloud --backend image-api` 启动，并配置 `IMAGE_WORKBENCH_PUBLIC_ORIGIN` 与 `IMAGE_WORKBENCH_WORKER_TOKEN`；本地联调可使用回环地址作为源站，公网使用 HTTPS。

图片 API Worker 可与网站部署在同一服务器，也可运行在独立主机。Linux 模板为 [image-api-worker.service](../deploy/image-api-worker.service) 和 [多实例模板](../deploy/image-api-worker@.service)。Windows 等环境可明确选择后端：

```powershell
$workerConfig = Get-Content 'deploy/remote-worker.local.json' -Raw | ConvertFrom-Json
$env:IMAGE_WORKBENCH_WORKER_TOKEN = $workerConfig.worker_token
$env:IMAGE_WORKBENCH_IMAGE_API_CONFIG = (Resolve-Path 'deploy/image-api.local.json').Path
.\.venv\Scripts\python.exe -m image_workbench remote-worker --server $workerConfig.server --cache-root $workerConfig.cache_root --backend image-api
```

`remote-worker.local.json` 按 [执行器配置示例](../deploy/remote-worker.example.json) 填写 `server`、`worker_token`、`cache_root`。已有 `scripts/start_remote_worker.ps1` 包装器仍使用兼容默认后端，不能直接把它当作上述 API 命令的替代。

文本及视频规划进程使用同一类本站认证配置，但各自使用独立持久缓存：

```powershell
$env:IMAGE_WORKBENCH_TEXT_API_CONFIG = (Resolve-Path 'deploy/text-api.local.json').Path
# 脚本任务执行器
.\.venv\Scripts\python.exe -m image_workbench.script_remote_worker --config deploy/remote-worker.local.json
# 在另一个进程启动视频提示词规划器
.\.venv\Scripts\python.exe -m image_workbench online-video-planner --worker-config deploy/remote-worker.local.json --cache work/online-video-planner
```

视频执行器读取的 JSON 字段为 `server`、`worker_token`、`api_key`、`worker_id`、`journal_dir`。其中 `api_key` 是视频供应方密钥，`worker_id` 是持久的 32 位十六进制标识，`journal_dir` 必须是持久目录：

```powershell
$env:IMAGE_WORKBENCH_ONLINE_VIDEO_CONFIG = (Resolve-Path 'deploy/online-video.local.json').Path
.\.venv\Scripts\python.exe -m image_workbench.online_video_worker
```

启动执行器会处理队列中已经确认的任务，不应把生产队列用作启动测试。完整服务器布局见 [远程图片部署](remote_deployment.md) 和 [一键发布](one_click_deploy.md)。

## 历史兼容与验证边界

`CodexImageBackend`、`CodexTextAdapter`、`h3-worker` 及旧配置仍在仓库中。部分底层构造器和 CLI 为兼容保留旧默认值；当前 Web 装配和显式 API 启动命令才是本文描述的流程。旧任务、执行记录和候选文件必须按其原后端恢复，不能仅改后台名称就重新提交。

自动化检查使用 Mock HTTP、固定图片、临时数据和真实浏览器，覆盖权限、队列、积分、接口与恢复；不据此保证供应商实时容量或生成质量。历史 Codex/H3 验收数字只代表当时环境。当前模块入口见 [架构说明](architecture.md)，部署状态见 [带日期的运行记录](tencent_live_deployment.md)。
