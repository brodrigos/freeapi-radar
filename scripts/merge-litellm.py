#!/usr/bin/env python3
"""Mescla entradas do Free API Radar no config.yaml do LiteLLM, sem reformatar o arquivo.

- insere no fim do bloco `model_list:` (antes da próxima chave top-level)
- não sobrescreve model_name existente com parâmetros diferentes
- valida com PyYAML: parseia, cresce só o esperado e preserva as entradas antigas
- faz backup antes de escrever; sem --apply apenas mostra o que faria

Uso:
  python scripts/merge-litellm.py --config //NAS/docker/litellm-gateway/config.yaml \
      --add scripts/litellm-keyless.yaml --apply
"""
import argparse
import datetime as dt
import re
import shutil
import sys
from pathlib import Path

import yaml

# Console do Windows costuma vir em cp1252; garante saída UTF-8 sem quebrar.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def load_entries(path: Path):
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    entries = data.get("model_list")
    if not isinstance(entries, list) or not entries:
        raise SystemExit(f"{path}: esperado 'model_list' com ao menos uma entrada")
    return entries


def top_level_keys(lines):
    return [(i, m.group(1)) for i, line in enumerate(lines) if (m := re.match(r"^([a-z_]+):\s*$", line))]


def insert_block(text: str, block: str) -> str:
    lines = text.splitlines(keepends=True)
    keys = top_level_keys(lines)
    names = [name for _, name in keys]
    if "model_list" not in names:
        raise SystemExit("config sem bloco 'model_list:'")

    start = names.index("model_list")
    end = keys[start + 1][0] if start + 1 < len(keys) else len(lines)
    if end == len(lines) and lines and not lines[-1].endswith("\n"):
        lines[-1] += "\n"

    head = lines[:end]
    tail = lines[end:]
    if head and head[-1].strip():
        head.append("\n")
    return "".join(head) + block + ("\n" if tail and not block.endswith("\n") else "") + "".join(tail)


def main():
    ap = argparse.ArgumentParser(description="Mescla model_list do radar no config do LiteLLM")
    ap.add_argument("--config", required=True)
    ap.add_argument("--add", required=True, help="yaml com model_list (snippet do radar)")
    ap.add_argument("--apply", action="store_true", help="grava (sem isso, só mostra o plano)")
    args = ap.parse_args()

    config_path = Path(args.config)
    add_path = Path(args.add)
    original = config_path.read_text(encoding="utf-8")
    current = yaml.safe_load(original) or {}
    existing = current.get("model_list") or []
    incoming = load_entries(add_path)

    by_name = {}
    for entry in existing:
        by_name.setdefault(entry.get("model_name"), []).append(entry)

    to_add, skipped = [], []
    for entry in incoming:
        name = entry.get("model_name")
        if not name:
            skipped.append(("sem model_name", entry))
            continue
        if name in by_name:
            same = any(e.get("litellm_params") == entry.get("litellm_params") for e in by_name[name])
            skipped.append((f"já existe ({'idêntico' if same else 'parâmetros diferentes'})", name))
            continue
        to_add.append(entry)

    if not to_add:
        print("nada a adicionar — config já está em dia")
        for reason, name in skipped:
            print(f"  · {name}: {reason}")
        return 0

    block_lines = []
    for entry in to_add:
        rendered = yaml.safe_dump([entry], sort_keys=False, allow_unicode=True, default_flow_style=False)
        block_lines.append(rendered)
    block = "".join(block_lines)

    updated = insert_block(original, block)

    # --- validação: parseia, cresce o esperado e preserva o que existia ---
    parsed = yaml.safe_load(updated)
    new_list = parsed.get("model_list") or []
    if len(new_list) != len(existing) + len(to_add):
        raise SystemExit(f"validação falhou: esperava {len(existing) + len(to_add)} entradas, veio {len(new_list)}")
    for before, after in zip(existing, new_list):
        if before != after:
            raise SystemExit("validação falhou: entradas antigas foram alteradas")
    for key, value in current.items():
        if key != "model_list" and parsed.get(key) != value:
            raise SystemExit(f"validação falhou: bloco '{key}' mudou")

    print(f"config: {config_path}")
    print(f"entradas: {len(existing)} → {len(new_list)}")
    for entry in to_add:
        print(f"  + {entry.get('model_name')}  ({entry.get('litellm_params', {}).get('model')})")
    for reason, name in skipped:
        print(f"  · pulado {name}: {reason}")

    if not args.apply:
        print("\n(dry-run) use --apply para gravar")
        return 0

    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = config_path.with_name(f"{config_path.name}.bak-radar-{stamp}")
    shutil.copy2(config_path, backup)
    config_path.write_text(updated, encoding="utf-8")
    print(f"\ngravado. backup: {backup.name}")
    print("reinicie o container do LiteLLM para o gateway carregar os modelos novos.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
