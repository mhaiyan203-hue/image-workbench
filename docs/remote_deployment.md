# 图片 API 的远程队列部署

`cloud` 运行网站和持久队列，`remote-worker --backend image-api` 领取任务、下载参考图、调用图片 API 并回传候选文件。执行器可以与网站同机，也可以部署在独立主机。图片 API 流程不依赖本机 Codex 登录；文本、分镜和视频的独立进程见 [当前 API 流程](api_runtime.md)。

```text
浏览器 → 网站 / 持久队列 / 积分账本
                    ↕ 本站 Worker HTTP 协议
              图片执行器 → 图片供应方 API
                    ↓
              校验、回传、正式归档
```

## 执行与恢复保证

- Worker 离线时，已受理任务保持排队；恢复上线后领取。
- 参考图和历史编辑基底按内容哈希校验，修改结果保留原图关联。
- 领取、启动许可和检查点落盘，已领取任务不会因心跳超时自动交给另一台执行器重跑。
- 候选图片先保存在执行器持久缓存。回传中断、回执丢失或服务重启后重传原图片；归档复用固定图片 ID。
- 执行结果无法确认时保留冻结积分和执行名额，不把未知请求当成明确失败。图片 Provider 内部的有限重试规则见 [图片 API 协议](image_api_integration.md)。
- 浏览器使用个人账号与 Workspace 隔离；执行器使用独立 Bearer 令牌。供应方 Key 只交给实际调用图片 API 的进程。

## 服务器配置

运行环境使用 Python 3.12，发布流程面向 Linux/systemd。版本位于 `/opt/image-workbench/releases/<版本号>/`，`/opt/image-workbench/current` 指向当前版本，业务数据放在 `/var/lib/image-workbench`。专用用户 `image-workbench` 负责运行服务。

将 [cloud.env.example](../deploy/cloud.env.example) 的真实配置放到 `/etc/image-workbench.env`，限制文件权限。当前 API 部署必须显式设置图片后端：

```ini
IMAGE_WORKBENCH_PUBLIC_ORIGIN=https://images.example.com
IMAGE_WORKBENCH_WORKER_TOKEN=填写至少32个ASCII字符的随机令牌
IMAGE_WORKBENCH_IMAGE_BACKEND=image-api
```

执行器令牌可用 `python -c "import secrets; print(secrets.token_urlsafe(32))"` 生成。它用于本站认证，不能用图片供应方 API Key 代替。浏览器沿用个人账号登录；旧数据迁移见 [账号、空间与积分](accounts_workspaces_credits.md)。

安装 [网站 systemd 模板](../deploy/image-workbench.service)，按 [一键发布](one_click_deploy.md) 完成服务器目录与首次发布。网站监听 `127.0.0.1:7860`，前方使用 [Nginx 模板](../deploy/nginx.conf.example) 提供 HTTPS。代理保留 Host、Authorization，上传上限至少 41 MiB；公网源站与配置一致。

同服务器的图片执行器使用 [image-api-worker.service](../deploy/image-api-worker.service)。将图片供应方的 `base_url`、`api_key`、`model` 存入 `/etc/image-workbench-image-api.json`，属主为服务用户、权限 `0600`；创建其可写持久缓存 `/var/lib/image-workbench-image-api`。模板明确传入 `--backend image-api`，并在网站服务重启时联动重启。

## 独立主机的图片执行器

在执行主机安装 `requirements-web.txt`。按 [Worker 示例](../deploy/remote-worker.example.json) 创建 `deploy/remote-worker.local.json`，填写 `server`、`worker_token`、`cache_root`；按 [图片 API 示例](../deploy/image-api.example.json) 创建 `deploy/image-api.local.json`。私密配置不提交 Git。

在项目根目录运行：

```powershell
$workerConfig = Get-Content 'deploy/remote-worker.local.json' -Raw | ConvertFrom-Json
$env:IMAGE_WORKBENCH_WORKER_TOKEN = $workerConfig.worker_token
$env:IMAGE_WORKBENCH_IMAGE_API_CONFIG = (Resolve-Path 'deploy/image-api.local.json').Path
.\.venv\Scripts\python.exe -m image_workbench remote-worker --server $workerConfig.server --cache-root $workerConfig.cache_root --backend image-api
```

保持进程运行。默认每 5 秒检查新任务、执行中每 15 秒发送心跳；`--once` 最多处理一项。启动 Worker 不创建新任务，但会执行已经确认提交的排队任务。旧的 `scripts/start_remote_worker.ps1` 包装器使用 Codex 默认后端，不能直接代替上述 API 命令。

缓存保存 Worker 身份、检查点、参考图和原始结果。每个进程使用独立持久目录；更换服务器或后端时也使用独立缓存。有未回传结果时不要清空或更换目录。

## 并发配置

在网站环境中配置并重启服务；管理员页面显示实际配置与占用：

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `IMAGE_WORKBENCH_MAX_ACTIVE_TOTAL` | `1` | 全站已领取与结果未知的图片任务上限，整数 `1..32` |
| `IMAGE_WORKBENCH_MAX_ACTIVE_PER_ACCOUNT` | `1` | 每个网站账号占用的执行名额上限，整数 `1..32` |

两项均不接受 `0` 表示无限。`MAX_PENDING_*` 控制提交容量，`MAX_ACTIVE_*` 控制领取名额；冻结积分的任务数不等于正在调用 API 的任务数。增加名额后还需相应数量的独立 Worker 及缓存，例如 [systemd 多实例模板](../deploy/image-api-worker@.service)。供应方自身的限流和额度仍独立生效。

Worker 每次顺序处理一项，本地 `web`／`worker` 模式有效并发仍为 1。领取在同一控制锁内检查总量与账号占用；队首账号占满时可选择后续有名额的账号。心跳过期、断线或 `uncertain` 不释放名额，降低上限也不丢弃已领取任务。

## 中断处理

网络或回传中断时恢复同一 Worker 和原缓存，只续传已有结果。网站存在可恢复候选文件时使用“恢复归档结果”，不再次调用模型。

执行器异常退出后，先核对原进程、检查点、候选文件和供应方记录。确认原执行已停止且没有待恢复结果后，才在上述命令后加 `--confirm-stopped <作业ID> --once`。该命令只更新状态，不终止供应方请求；再次生成需要用户显式重试。

缓存丢失时优先恢复备份。服务器启动许可会拒绝新检查点重复执行旧作业；无法恢复时，由管理员核实原执行与结果后，在服务器原数据根目录使用 `worker-confirm-stopped --project <项目ID> --task <任务ID> --confirm-stopped`。不要只因本地连接断开就认定供应方没有受理。

业务数据与执行器缓存分开备份；迁移按 [备份恢复说明](backup_restore.md) 执行。历史 Codex 任务必须按原后端和原缓存恢复，参考 [历史执行环境](codex_environment.md)。

## 验证

```powershell
.\.venv\Scripts\python.exe -X utf8 scripts/verify.py --module images
.\.venv\Scripts\python.exe -X utf8 scripts/remote_rehearsal.py
```

自动化检查和回环 HTTP 演练使用临时数据与本地/Mock 图片，覆盖登录隔离、领取、回传、归档与恢复。它们不证明真实供应方当前可用或图片质量；真实调用的历史验收见 [图片 API 发布记录](image_api_release_20261023.md)，服务器运行记录见 [部署核验](tencent_live_deployment.md)。
