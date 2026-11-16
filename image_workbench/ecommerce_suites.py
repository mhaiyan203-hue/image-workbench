"""Fixed ecommerce suites compiled from skills, using existing image jobs and ledger."""
import hashlib
import json
from pathlib import Path
from uuid import UUID, uuid4, uuid5

from .accounts import CreditCostCalculator
from .asset_library import AssetLibrary
from .domain_errors import ConflictError
from .locking import FileLock
from .storage import _now, _validate_id


SKILLS = Path(__file__).resolve().parents[1] / "skills" / "ecommerce-suites"
TEMPLATE_IDS = ("clothing-model", "small-product")


def template(template_id):
    if template_id not in TEMPLATE_IDS:
        raise ValueError("未知套图模板")
    value = json.loads((SKILLS / template_id / "template.json").read_text(encoding="utf-8"))
    if not 1 <= len(value["slots"]) <= 15:
        raise ValueError("套图模板张数无效")
    return value


class EcommerceSuites:
    def __init__(self, state):
        self.state = state
        self.storage = state.storage

    def catalog(self):
        ordinary_unit = CreditCostCalculator.calculate("generate", self.state.backend, 1, 1)
        items = [template(key) for key in TEMPLATE_IDS]
        return [{**item, "image_count": len(item["slots"]),
                 "original_credit": ordinary_unit * len(item["slots"]),
                 "package_credit": (ordinary_unit // 2) * len(item["slots"]),
                 "unit_credit": ordinary_unit // 2} for item in items]

    def plan(self, template_id, product, model_description=""):
        item = next(value for value in self.catalog() if value["id"] == template_id)
        skill = (SKILLS / template_id / "SKILL.md").read_text(encoding="utf-8")
        prompts = []
        for slot in item["slots"]:
            prompts.append({**slot, "prompt": f"{skill}\n\n商品资料：\n{product}\n"
                            + (f"固定模特设定：{model_description}\n" if item["with_model"] and model_description else "")
                            + f"\n本次只生成第{slot['id']}张：{slot['name']}。\n{slot['prompt']}\n画面宽高比1:1。"})
        return {**item, "slots": prompts}

    def _path(self, project_id, suite_id):
        self.state.projects.get_main_project(project_id)
        directory = self.storage.files.path(".workbench", "ecommerce", _validate_id(project_id))
        return directory / (_validate_id(suite_id) + ".json")

    def get(self, project_id, suite_id):
        record = self.storage.files.read_json(self._path(project_id, suite_id))
        tasks = []
        for slot in record["slots"]:
            try:
                tasks.append(self.state.logical_task_view(slot["task_id"], main_project_id=project_id))
            except FileNotFoundError:
                tasks.append({"task_id": slot["task_id"], "name": slot["name"], "status": "preparing", "outputs": []})
        return {**record, "image_count": len(record["slots"]), "tasks": tasks}

    def list(self, project_id):
        directory = self._path(project_id, "0" * 32).parent
        return [self.get(project_id, path.stem) for path in sorted(directory.glob("*.json"), reverse=True)]

    def submit(self, project_id, *, request_id, template_id, subproject_id, reference_artifact_ids, prompts):
        item = next(value for value in self.catalog() if value["id"] == template_id)
        if any(not p.strip() or len(p) > 12000 for p in prompts):
            raise ValueError("请提供非空提示词，每条最多12000字")
        if not reference_artifact_ids or len(set(reference_artifact_ids)) != len(reference_artifact_ids):
            raise ValueError("请提供商品参考图，不能重复")
        sub = self.state.projects.get_subproject(subproject_id)
        if sub.main_project_id != project_id:
            raise ValueError("子项目不匹配")
        library = AssetLibrary(self.state)
        for ref in reference_artifact_ids:
            library.require(subproject_id, ref)
        path = self._path(project_id, request_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        fingerprint = hashlib.sha256(json.dumps([template_id, subproject_id, reference_artifact_ids, prompts],
                                               ensure_ascii=False).encode()).hexdigest()
        with FileLock(path.with_suffix(".lock"), timeout=30):
            if path.exists():
                record = self.storage.files.read_json(path)
                if record["fingerprint"] != fingerprint:
                    raise ConflictError("套餐提交内容已改变，请新建套餐")
            else:
                if len(prompts) != len(item["slots"]):
                    raise ConflictError("套餐内容已更新，请刷新页面后重新展开模板")
                record = {"schema_version": 1, "suite_id": request_id, "project_id": project_id, "subproject_id": subproject_id,
                          "template_id": template_id, "template_version": item["version"], "name": item["name"],
                          "fingerprint": fingerprint, "created_at": _now(), "status": "preparing",
                          "original_credit": item["original_credit"], "package_credit": item["package_credit"],
                          "unit_credit": item["unit_credit"], "reference_artifact_ids": reference_artifact_ids,
                          "slots": [{"task_id": uuid5(UUID(request_id), slot["id"]).hex, "name": slot["name"],
                                     "prompt": prompt} for slot, prompt in zip(item["slots"], prompts, strict=True)]}
                self.storage.files.write_json(path, record)
            if record["status"] == "submitted":
                return self.get(project_id, request_id)
            for slot in record["slots"]:
                self.state.create_task(project_id, request_id=slot["task_id"], operation="generate",
                                       prompt=slot["prompt"], aspect_ratio="1:1", subproject_id=subproject_id,
                                       name=f"{record['name']} · {slot['name']}", reference_artifact_ids=reference_artifact_ids,
                                       commerce_suite={"suite_id": request_id, "unit_credit": record["unit_credit"]})
            with self.state.control_lock():
                owner = self.state.identity.ownership(project_id)
                pid = self.state.projects.ensure_storage_namespace(project_id)
                jobs = []
                for slot in record["slots"]:
                    jobs.append({"schema_version": 1, "job_id": uuid4().hex,
                                 "commerce_suite_id": request_id,
                                 "request_id": uuid5(UUID(request_id), "run-" + slot["task_id"]).hex,
                                 "project_id": pid, "task_id": slot["task_id"], "backend": self.state.backend,
                                 "action": "generate", "confirmed": True, "restore_execution_id": None,
                                 "previous_execution_id": None, "execution_id": None, "status": "queued",
                                 "failure_type": None, "created_at": _now(), "started_at": None, "finished_at": None})
                jobs = self.state.identity.reserve_many(jobs, owner, [record["unit_credit"]] * len(record["slots"]))
                for job in jobs:
                    # A retried response must not overwrite a running/settled outbox job.
                    current = self.state.get_job(pid, job["task_id"])
                    if current is None:
                        self.state.save_job(job)
                record["status"] = "submitted"
                self.storage.files.write_json(path, record)
        return self.get(project_id, request_id)
