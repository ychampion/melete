"""List the pinned loader's hooks and literal dispatch sites without importing Hermes.

This is source evidence, not a claim that a branch executes on the HTTP run path.
The audit note records those path and payload distinctions separately.
"""

from __future__ import annotations

import ast
import sys
import warnings
from pathlib import Path


def main() -> None:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".hermes-src").resolve()
    loader = root / "hermes_cli/plugins.py"
    tree = ast.parse(loader.read_text(encoding="utf-8"))
    declarations = [
        node
        for node in tree.body
        if isinstance(node, ast.AnnAssign)
        and isinstance(node.target, ast.Name)
        and node.target.id == "VALID_HOOKS"
    ]
    if len(declarations) != 1:
        raise ValueError("Expected one VALID_HOOKS declaration in the pinned loader")
    hooks = ast.literal_eval(declarations[0].value)
    if not isinstance(hooks, set) or not all(isinstance(name, str) for name in hooks):
        raise ValueError("Expected a literal set of hook names")

    sites: dict[str, set[str]] = {name: set() for name in sorted(hooks)}
    files = [root / name for name in ("model_tools.py", "run_agent.py", "cli.py")]
    for directory in ("agent", "hermes_cli", "gateway", "tools"):
        files.extend((root / directory).rglob("*.py"))
    for path in sorted(set(files)):
        if not path.is_file() or "tests" in path.relative_to(root).parts:
            continue
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", SyntaxWarning)
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not node.args:
                continue
            first = node.args[0]
            if not isinstance(first, ast.Constant) or not isinstance(first.value, str):
                continue
            if first.value not in hooks:
                continue
            function = ast.unparse(node.func)
            if not any(word in function for word in ("hook", "lifecycle", "emit")):
                continue
            if "has_hook" in function or "register" in function:
                continue
            sites[first.value].add(f"{path.relative_to(root).as_posix()}:{node.lineno}")

    print(f"VALID_HOOKS: {len(hooks)} ({loader.relative_to(root).as_posix()}:{declarations[0].lineno})")
    for name, references in sites.items():
        print(f"{name}: {'; '.join(sorted(references)) or 'indirect dispatch; inspect producer'}")
    print("Literal dispatch sites do not establish HTTP reachability or durable delivery.")


if __name__ == "__main__":
    main()
