# 电商十五张套图

服装模板使用同一成年模特，小商品模板不出现人物；每套十五个独立图片任务。参考图必填。套餐按参考图生成的原价五折，目前原价900、套餐450、单张30积分；报价由服务端计算，客户端不能传价格。明确失败退回折后单张金额，显式重试仍按套餐快照价冻结；状态待确认保留冻结，不自动重跑。

## 实现与兼容

归属 Images Application Service + Skill + Frontend，复用 WorkbenchState.create_task、AssetLibrary、既有Worker与StorageManager产物归档。新增 ecommerce_suites 模块在 architecture.json 的 images 组注册，不改动跨媒体Core。独立页面 /ecommerce 通过当前登录Workspace访问，与试用账号的图片权限兼容。

两套预设Skill和十五张槽位保存在 skills/ecommerce-suites，各自包含提示词编辑Skill；编辑的可执行规则登记在原有prompt-enhancement注册表，显式选择skill_id，继续使用现有DeepSeek提示词编辑服务。预设Skill正文实际编入每张任务的提示词，最终提示词、模板版本和价格快照随套图保存。

新增套图记录位于 .workbench/ecommerce/{main_project_id}/{suite_id}.json，schema_version=1；任务options增加可选commerce_suite，旧记录缺失该字段保持原单张价格。每个套餐生成确定性的十五个任务ID与提交请求ID。IdentityStore.reserve_many在同一SQLite事务中调用既有冻结逻辑并写十五个作业outbox；余额或容量不足整批回滚。套餐在账号/全站待处理上限中计为一次提交，套内任务仍逐张执行；普通单张仍计一次，每日提交积分预算仍逐张累计。发布JSON失败可通过原outbox恢复，重新提交相同内容不会再次冻结；内容不同返回409。准备中的套餐不能从普通单任务run端点绕过整套提交。

不迁移既有数据。回滚时保留新套图记录、任务options和账本，以保留已受理任务的恢复与折扣重试；若回退到不理解commerce_suite的旧代码，应关闭新套餐入口并先完成已受理工作，不直接删除记录或积分流水。

## HTTP

- GET /api/ecommerce/templates：两套模板、各15个槽位、服务端报价。
- POST /api/ecommerce/plan：template_id、product、model_description；返回可编辑提示词，不扣费、不调用生图。
- POST /api/main-projects/{id}/suites：request_id、template_id、subproject_id、reference_artifact_ids、15条prompts、confirm_generation=true；一次受理完整套餐。
- GET /api/main-projects/{id}/suites 与 /{suite_id}：范围内历史及逐张任务状态。
- GET /api/main-projects/{id}/suites/{suite_id}/download：核验产物后打包已完成图片ZIP。
- 单张失败重试复用 /api/tasks/{task_id}/run，保留既有幂等、恢复和权限规则。

## 来源与验证

本次模板与规则为网站场景重新编写；调研参考 PixGT ecommerce-ai-prompts 的商品/场景维度和 along-ai-tech ecommerce-design-skill-pack 的套图用途划分，没有整库导入第三方提示词或示例图。案例参考图为本次生成的无品牌虚构商品。

回归覆盖：模板与编辑Skill加载；十五张完整计价；余额和容量不足原子回滚；重复请求；中途发布失败恢复；按折后单价成功结算、失败退款与重试；跨账号/空间隔离；下载；客户端改价与改张数拒绝。案例真实出图与线上核验记录另存本次work报告。完整发布前运行 scripts/verify.py。
