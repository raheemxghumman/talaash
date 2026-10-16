"""MCP server at /mcp so any MCP-capable assistant can work with the desk.

Requests need `Authorization: Bearer <MCP_TOKEN>`."""

import hmac

from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from starlette.responses import JSONResponse

from app import config, tools

mcp = FastMCP(
    "Talaash",
    instructions=(
        "Lost-child desk for a crowded venue. You can list active searches, read a case, file a sighting, and report a found child. "
        "You cannot approve alerts, confirm sightings or close cases: a human desk officer does that."
    ),
    stateless_http=True,
    json_response=True,
    streamable_http_path="/mcp",
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)


@mcp.tool()
def list_zones() -> list[str]:
    """The venue zones a sighting can be filed under."""
    return tools.list_zones()


@mcp.tool()
def list_open_cases(zone: str | None = None) -> list[dict]:
    """Active lost-child searches (approved by the desk officer). Cases last seen in `zone` come first."""
    return tools.list_open_cases(zone)


@mcp.tool()
def get_case(case_id: int) -> dict:
    """Description, search stage and recent timeline of one case."""
    return tools.get_case(case_id)


@mcp.tool()
def report_sighting(description: str, zone: str, reporter: str = "") -> dict:
    """File what a staff member can see. The matcher scores it and the desk officer decides. Zone must be one of list_zones()."""
    return tools.report_sighting(description, zone, reporter)


@mcp.tool()
def report_found_child(description: str, zone: str, reporter: str = "") -> dict:
    """A lost child is with the reporter right now. Files it for the desk officer, who sends staff. Zone must be one of list_zones()."""
    return tools.report_found_child(description, zone, reporter)


class BearerAuth:
    """Rejects /mcp requests without the right bearer token."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["path"].startswith("/mcp"):
            headers = dict(scope.get("headers") or [])
            sent = headers.get(b"authorization", b"").decode()
            expected = f"Bearer {config.MCP_TOKEN}"
            if not config.MCP_TOKEN or not hmac.compare_digest(sent, expected):
                await JSONResponse({"error": "unauthorized"}, status_code=401)(scope, receive, send)
                return
        await self.app(scope, receive, send)


def asgi_app():
    return BearerAuth(mcp.streamable_http_app())
