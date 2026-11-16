"""Ecommerce suite request contracts. Prices and job IDs are server-owned."""
from typing import Literal
from pydantic import Field
from .images import Payload


class SuitePlan(Payload):
    template_id: Literal["clothing-model", "small-product"]
    product: str = Field(min_length=1, max_length=2000)
    model_description: str = Field(default="", max_length=500)


class SuiteSubmit(Payload):
    request_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    template_id: Literal["clothing-model", "small-product"]
    subproject_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    reference_artifact_ids: list[str] = Field(min_length=1, max_length=8)
    # Historical fifteen-image purchases remain replayable; the service checks
    # the exact count against the current template or saved purchase snapshot.
    prompts: list[str] = Field(min_length=1, max_length=15)
    confirm_generation: Literal[True]
