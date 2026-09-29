from types import SimpleNamespace

from plugins.platforms.discord.adapter import DiscordAdapter

BOT_ID = 1001


def adapter() -> DiscordAdapter:
    instance = object.__new__(DiscordAdapter)
    instance._client = SimpleNamespace(user=SimpleNamespace(id=BOT_ID))
    return instance


def role(role_id: int, bot_id: int | None) -> SimpleNamespace:
    return SimpleNamespace(id=role_id, tags=SimpleNamespace(bot_id=bot_id) if bot_id is not None else None)


def message(content: str, *, role_mentions=(), guild=None) -> SimpleNamespace:
    return SimpleNamespace(content=content, mentions=[], role_mentions=list(role_mentions), guild=guild)


def guild(self_role=None, roles=()) -> SimpleNamespace:
    by_id = {r.id: r for r in roles}
    return SimpleNamespace(self_role=self_role, get_role=by_id.get)


own = role(2002, BOT_ID)
cases = {
    "own role in role_mentions": (message("<@&2002> q", role_mentions=[own], guild=guild()), True),
    "own role via guild.self_role": (message("<@&2002> q", guild=guild(self_role=own)), True),
    "own role via raw token lookup": (message("<@&2002> q", guild=guild(roles=[own])), True),
    "other bot managed role": (message("<@&3003> q", role_mentions=[role(3003, 9999)], guild=guild()), False),
    "plain role": (message("<@&4004> q", role_mentions=[role(4004, None)], guild=guild()), False),
    "role token in DM": (message("<@&2002> q"), False),
    "bot user mention": (message("<@1001> q", guild=guild()), True),
    "no mention": (message("q", guild=guild()), False),
}

failures = [name for name, (msg, expected) in cases.items() if adapter()._self_is_explicitly_mentioned(msg) is not expected]
if failures:
    raise SystemExit(f"Discord role-mention patch check failed: {failures}")
print(f"discord role-mention check passed ({len(cases)} cases)")
