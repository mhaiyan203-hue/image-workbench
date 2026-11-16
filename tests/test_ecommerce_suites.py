import io
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image
from image_workbench import StorageConfig, StorageManager, LocalFileBackend
from image_workbench.web import create_app
from image_workbench.worker import LocalWorker
from image_workbench.capacity import CapacityPolicy
from image_workbench.prompt_enhancement_skills import PromptSkillRegistry


class EcommerceSuiteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.storage = StorageManager(StorageConfig(data_root=self.root / "data"))
        self.app = create_app(self.storage, backend="local")
        self.client = self.user("buyer")
        self.me = self.client.get("/api/auth/me").json()
        self.aid = self.me["account_id"]
        self.mid, self.sid = uuid4().hex, uuid4().hex
        self.client.post("/api/main-projects", json={"name": "Suite", "request_id": self.mid}).raise_for_status()
        self.client.post(f"/api/main-projects/{self.mid}/subprojects", json={"name": "Images", "request_id": self.sid}).raise_for_status()
        self.image = self.root / "product.png"
        Image.new("RGB", (48, 48), "white").save(self.image)
        uploaded = self.client.post(f"/api/subprojects/{self.sid}/assets", files={"files": ("product.png", self.image.read_bytes(), "image/png")})
        uploaded.raise_for_status()
        self.refs = [a["artifact_id"] for a in uploaded.json()["assets"]]
        self.state = self.app.scoped_app(self.aid, self.me["workspace_id"]).state.workbench
        self.path = f"/api/main-projects/{self.mid}/suites"
        self.body = {"request_id": uuid4().hex, "template_id": "small-product", "subproject_id": self.sid,
                     "reference_artifact_ids": self.refs, "prompts": [f"商品静物图 {i}" for i in range(15)], "confirm_generation": True}

    def user(self, name):
        c = TestClient(self.app, base_url="http://localhost", raise_server_exceptions=False)
        self.addCleanup(c.close)
        c.headers["X-Workbench-CSRF"] = c.get("/api/auth/config").json()["csrf_token"]
        credentials = {"username": name, "password": "testing-password-123"}
        c.post("/api/auth/register", json=credentials).raise_for_status()
        c.post("/api/auth/login", json=credentials).raise_for_status()
        c.headers["X-Workbench-CSRF"] = c.get("/api/config").json()["csrf_token"]
        return c

    def fund(self):
        with self.app.identity.transaction() as db:
            db.execute("UPDATE credit_accounts SET total_credit=2000 WHERE account_id=?", (self.aid,))

    def test_catalog_plan_and_editing_skills(self):
        response = self.client.get("/api/ecommerce/templates")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(response.json()["templates"]), 2)
        registry = PromptSkillRegistry()
        for item in response.json()["templates"]:
            self.assertEqual((len(item["slots"]), item["original_credit"], item["package_credit"]), (15, 900, 450))
            self.assertIsNotNone(registry.get(item["editing_skill_id"]))
            plan = self.client.post("/api/ecommerce/plan", json={"template_id": item["id"], "product": "真实商品信息"})
            self.assertEqual(plan.status_code, 200, plan.text)
            self.assertTrue(all("真实商品信息" in slot["prompt"] for slot in plan.json()["slots"]))
        self.assertEqual(self.app.identity.wallet(self.aid)["frozen_credit"], 0)
        self.assertEqual(self.client.get("/ecommerce").status_code, 200)

    def test_insufficient_balance_rolls_back_entire_suite(self):
        response = self.client.post(self.path, json=self.body)
        self.assertEqual(response.status_code, 402, response.text)
        self.assertEqual(self.app.identity.wallet(self.aid)["frozen_credit"], 0)
        self.assertEqual(self.app.identity.pending_jobs(), [])
        tasks = self.client.get(self.path).json()["suites"][0]["tasks"]
        self.assertFalse(tasks[0]["can_generate"])
        direct = self.client.post(f"/api/tasks/{tasks[0]['task_id']}/run", json={"request_id": uuid4().hex, "confirm_generation": True})
        self.assertEqual(direct.status_code, 409)
        self.fund()
        self.assertEqual(self.client.post(self.path, json=self.body).status_code, 200)
        self.assertEqual(self.app.identity.wallet(self.aid)["frozen_credit"], 450)

    def test_idempotence_settlement_download_and_isolation(self):
        self.fund()
        response = self.client.post(self.path, json=self.body)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(response.json()["tasks"]), 15)
        self.assertEqual(self.client.post(self.path, json=self.body).status_code, 200)
        self.assertEqual(len(self.app.identity.pending_jobs()), 15)
        self.assertEqual(self.app.identity.wallet(self.aid)["frozen_credit"], 450)
        self.assertEqual({t["estimated_credit"] for t in response.json()["tasks"]}, {30})
        worker = LocalWorker(self.app.state.workbench, LocalFileBackend([self.image]))
        self.assertTrue(worker.run_next())
        self.assertEqual(self.app.identity.wallet(self.aid)["used_credit"], 30)
        zipped = self.client.get(self.path + '/' + self.body["request_id"] + '/download')
        self.assertEqual(zipped.status_code, 200, zipped.text if zipped.status_code != 200 else '')
        import zipfile
        self.assertEqual(len(zipfile.ZipFile(io.BytesIO(zipped.content)).namelist()), 1)
        other = self.user("otherbuyer")
        self.assertEqual(other.get(self.path).status_code, 404)
        self.assertEqual(other.post(self.path, json=self.body).status_code, 404)
        self.assertEqual(other.get(self.path + '/' + self.body["request_id"] + '/download').status_code, 404)
        altered = {**self.body, "prompts": ["changed"] * 15}
        self.assertEqual(self.client.post(self.path, json=altered).status_code, 409)

    def test_failure_refunds_discounted_unit_and_retry_keeps_price(self):
        self.fund()
        self.client.post(self.path, json=self.body).raise_for_status()
        job = self.app.identity.pending_jobs()[0]
        job.update(status="failed", failure_type="backend_error")
        self.app.state.workbench.save_job(job)
        self.assertEqual(self.app.identity.wallet(self.aid)["frozen_credit"], 420)
        response = self.client.post(f"/api/tasks/{job['task_id']}/run", json={"request_id": uuid4().hex, "confirm_generation": True, "retry_of": job["job_id"]})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.app.identity.wallet(self.aid)["frozen_credit"], 450)

    def test_capacity_failure_rolls_back_and_recovery_uses_outbox(self):
        self.fund()
        self.state.identity.capacity_policy = CapacityPolicy(max_pending_per_account=10)
        response = self.client.post(self.path, json=self.body)
        self.assertEqual(response.status_code, 429, response.text)
        self.assertEqual(self.app.identity.pending_jobs(), [])
        self.assertEqual(self.app.identity.wallet(self.aid)["frozen_credit"], 0)
        self.state.identity.capacity_policy = CapacityPolicy()
        with patch.object(self.state, "save_job", side_effect=OSError("simulated interruption")):
            self.assertEqual(self.client.post(self.path, json=self.body).status_code, 500)
        self.assertEqual(len(self.app.identity.pending_jobs()), 15)
        self.assertEqual(self.client.post(self.path, json=self.body).status_code, 200)
        self.assertEqual(self.app.identity.wallet(self.aid)["frozen_credit"], 450)

    def test_client_cannot_override_price_or_count(self):
        for extra in ({"package_credit": 1}, {"prompts": ["x"] * 14}, {"confirm_generation": False}):
            self.assertEqual(self.client.post(self.path, json={**self.body, **extra}).status_code, 422)
