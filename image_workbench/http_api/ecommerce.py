"""Scoped suite routes; use existing asset upload and image download contracts."""
import io
import zipfile
from fastapi import Request
from fastapi.responses import StreamingResponse
from ..contracts.ecommerce import SuitePlan, SuiteSubmit


def install_routes(app, service, templates):
    @app.get("/ecommerce")
    def page(request: Request):
        return templates.TemplateResponse(request=request, name="ecommerce.html", context={},
                                          headers={"Cache-Control": "no-store"})

    @app.get("/api/ecommerce/templates")
    def catalog():
        return {"templates": service.catalog()}

    @app.post("/api/ecommerce/plan")
    def plan(body: SuitePlan):
        return service.plan(body.template_id, body.product, body.model_description)

    @app.post("/api/main-projects/{project_id}/suites")
    def submit(project_id: str, body: SuiteSubmit):
        return service.submit(project_id, **body.model_dump(exclude={"confirm_generation"}))

    @app.get("/api/main-projects/{project_id}/suites")
    def suites(project_id: str):
        return {"suites": service.list(project_id)}

    @app.get("/api/main-projects/{project_id}/suites/{suite_id}")
    def suite(project_id: str, suite_id: str):
        return service.get(project_id, suite_id)

    @app.get("/api/main-projects/{project_id}/suites/{suite_id}/download")
    def download(project_id: str, suite_id: str):
        record = service.get(project_id, suite_id)
        stream = io.BytesIO()
        count = 0
        with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
            for i, task in enumerate(record["tasks"], 1):
                for output in task.get("outputs", []):
                    path = service.storage.get_artifact_path(output["artifact_id"])
                    if hashlib_sha256(path) != service.storage.get_artifact(output["artifact_id"]).sha256:
                        raise ValueError("产物校验失败")
                    archive.write(path, f"{i:02d}-{output['artifact_id']}{path.suffix}")
                    count += 1
        if not count:
            raise ValueError("暂无已完成图片")
        stream.seek(0)
        return StreamingResponse(stream, media_type="application/zip",
                                 headers={"Content-Disposition": f'attachment; filename="suite-{suite_id}.zip"'})


def hashlib_sha256(path):
    import hashlib
    return hashlib.sha256(path.read_bytes()).hexdigest()
