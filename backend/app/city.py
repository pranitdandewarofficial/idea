"""City layout — the single source of truth for what the 2D city renders.

The frontend never invents positions: it asks ``GET /api/city`` and draws exactly
this.  Building occupancy and avatar state are joined with live agent rows, so a
building only lights up when a real department is really processing work.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

WORLD_WIDTH = 1680
WORLD_HEIGHT = 1120


@dataclass(frozen=True)
class Building:
    id: str
    name: str
    department: str
    x: int
    y: int
    w: int
    h: int
    color: str
    accent: str
    icon: str
    detail: str = ""
    seats: tuple[tuple[int, int], ...] = field(default_factory=tuple)


BUILDINGS: tuple[Building, ...] = (
    Building(
        id="command-tower", name="Command Tower", department="Command Tower",
        x=700, y=120, w=240, h=190, color="#eef0ff", accent="#5b6cff", icon="tower",
        detail="The orchestrator plans, schedules and verifies from here.",
        seats=((760, 250), (880, 250)),
    ),
    Building(
        id="decision-lab", name="Decision Lab", department="Decision Lab",
        x=1010, y=150, w=190, h=140, color="#f3f0ff", accent="#7950f2", icon="pulse",
        detail="System 1: fast, typed decisions with calibrated confidence.",
        seats=((1105, 250),),
    ),
    Building(
        id="product-studio", name="Product Studio", department="Product Studio",
        x=420, y=160, w=210, h=150, color="#e9fbfd", accent="#0b8fa8", icon="clipboard",
        detail="Requirements, acceptance criteria and scope control.",
        seats=((525, 265),),
    ),
    Building(
        id="design-studio", name="Design Studio", department="Design Studio",
        x=170, y=360, w=200, h=150, color="#fff2e8", accent="#e8590c", icon="palette",
        detail="Layouts, component trees, states and motion rules.",
        seats=((270, 465),),
    ),
    Building(
        id="research-lab", name="Research Lab", department="Research Lab",
        x=180, y=620, w=200, h=150, color="#f3f0ff", accent="#6741d9", icon="book",
        detail="Evidence-linked findings from approved sources.",
        seats=((280, 725),),
    ),
    Building(
        id="engineering-hq", name="Engineering HQ", department="Engineering HQ",
        x=1130, y=400, w=330, h=220, color="#e6f7f1", accent="#0ca678", icon="code",
        detail="Architecture, backend and frontend implementation.",
        seats=((1200, 470), (1300, 470), (1400, 470), (1250, 570), (1360, 570)),
    ),
    Building(
        id="collaboration-hub", name="Collaboration Hub", department="Collaboration Hub",
        x=730, y=470, w=220, h=160, color="#fbfbfd", accent="#868e96", icon="plaza",
        detail="Cross-team handoffs happen on the plaza.",
        seats=((790, 560), (890, 560)),
    ),
    Building(
        id="qa-center", name="QA Center", department="QA Center",
        x=720, y=800, w=230, h=160, color="#fff0f0", accent="#e03131", icon="flask",
        detail="Real tests, real output, real pass/fail evidence.",
        seats=((790, 900), (890, 900)),
    ),
    Building(
        id="security-ops", name="Security Ops", department="Security Ops Center",
        x=420, y=820, w=210, h=150, color="#f1f3f5", accent="#343a40", icon="shield",
        detail="Findings ranked by severity, with file and line.",
        seats=((525, 920),),
    ),
    Building(
        id="infra-center", name="Infrastructure Center", department="Infrastructure Center",
        x=1050, y=800, w=230, h=160, color="#ebfbee", accent="#2b8a3e", icon="server",
        detail="Containers, scripts, environments and previews.",
        seats=((1120, 900), (1220, 900)),
    ),
    Building(
        id="docs-delivery", name="Docs & Delivery", department="Docs & Delivery",
        x=1350, y=680, w=210, h=150, color="#e7f5ff", accent="#1c7ed6", icon="package",
        detail="README, API docs, decisions log and the final report.",
        seats=((1455, 780),),
    ),
)

BUILDING_BY_DEPARTMENT: dict[str, Building] = {b.department: b for b in BUILDINGS}
BUILDING_BY_ID: dict[str, Building] = {b.id: b for b in BUILDINGS}

#: Roads drawn between the plaza and each building entrance.
ROADS: tuple[tuple[tuple[int, int], tuple[int, int]], ...] = tuple(
    (((840, 550), (b.x + b.w // 2, b.y + b.h))) for b in BUILDINGS if b.id != "collaboration-hub"
)


def seat_for(agent_id: str, department: str, index: int = 0) -> tuple[float, float]:
    building = BUILDING_BY_DEPARTMENT.get(department)
    if building is None:
        building = BUILDING_BY_ID["collaboration-hub"]
    seats = building.seats or ((building.x + building.w // 2, building.y + building.h - 40),)
    seat = seats[index % len(seats)]
    return float(seat[0]), float(seat[1])


def building_for_department(department: str) -> dict[str, Any] | None:
    building = BUILDING_BY_DEPARTMENT.get(department)
    return asdict(building) if building else None


def city_layout(agents: list[dict[str, Any]]) -> dict[str, Any]:
    """Buildings + roads + agent seats, joined with live agent state."""
    seats_taken: dict[str, int] = {}
    placed: list[dict[str, Any]] = []
    for agent in agents:
        department = agent.get("department", "")
        building = BUILDING_BY_DEPARTMENT.get(department) or BUILDING_BY_ID["collaboration-hub"]
        index = seats_taken.get(building.id, 0)
        seats_taken[building.id] = index + 1
        home_x, home_y = seat_for(agent.get("id", ""), department, index)
        placed.append(
            {
                **agent,
                "building_id": building.id,
                "home_x": home_x,
                "home_y": home_y,
            }
        )
    return {
        "world": {"width": WORLD_WIDTH, "height": WORLD_HEIGHT},
        "buildings": [asdict(b) for b in BUILDINGS],
        "roads": [{"from": list(a), "to": list(b)} for a, b in ROADS],
        "agents": placed,
    }
