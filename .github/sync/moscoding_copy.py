#!/usr/bin/env python3
"""Собирает копию учебного набора для Moscow Coding School из набора Guide DAO.

    python3 moscoding_copy.py ПАПКА-НАБОРА-GUIDEDAO ПАПКА-КЛОНА-MOSCODING
    python3 moscoding_copy.py --message < сообщение-коммита

Ученики Moscow Coding School проходят те же уроки, что и ученики Guide DAO, но платформа ведёт их
в копии наборов на github.com/moscoding без имени Guide DAO: ученики не должны видеть связь школ
(решение владельца 24.10.2026, lms: shared/brands.mjs). Копию собирает этот скрипт, а запускает
.github/workflows/sync-moscoding.yml при каждом пуше в main, поэтому копия не отстаёт от набора.
Скрипт одинаковый в guidedao/claude-code-kit, vibecoding-kit и llm-wiki-agent.

Копирует все файлы набора, кроме .git и файлов самой синхронизации, заменяет в текстовых файлах
имя и адреса Guide DAO на Moscow Coding School и удаляет из копии файлы, которых в наборе больше
нет. Двоичные git-архивы (*.bundle) копируются как есть, но распаковываются и проверяются. Если
после замены где-то осталось «guidedao» или «Guide DAO», печатает находки и выходит с кодом 1:
правило надо дописать, а не публиковать копию с чужим именем. С --message заменяет имя
в сообщении коммита из stdin. Только стандартная библиотека и git.
"""
from __future__ import annotations

import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

KITS = "claude-code-kit|vibecoding-kit|vibecoding-capstone-starter|llm-wiki-agent"
# Порядок важен: сначала адреса и составные имена, потом голое имя.
RULES = [
    # guidedao/<набор> в адресах GitHub, raw.githubusercontent.com, Colab и в тексте.
    (re.compile(rf"\bguidedao/({KITS})(?![\w-])"), r"moscoding/\1"),
    (re.compile(r"yo@guidedao\.xyz"), "courses@moscoding.ru"),
    (re.compile(r"learn\.guidedao\.xyz"), "courses.moscoding.ru"),
    (re.compile(r"(?:www\.)?guidedao\.xyz", re.I), "moscoding.ru"),
    (re.compile(r"guidedao-launch"), "moscoding-launch"),
    # Служебная подпись временных коммитов в самопроверках набора (start/verify.py).
    (re.compile(r"\d+\+guidedao@users\.noreply\.github\.com"), "yo@moscoding.ru"),
    (re.compile(r"user\.name=guidedao\b"), "user.name=moscoding"),
    (re.compile(r"Guide ?DAO|Guidedao"), "Moscow Coding School"),
]
LEFTOVER = re.compile(r"guide ?dao", re.I)
# Файлы синхронизации в копию не идут; остальной .github (например, CI для учеников) идёт.
SYNC = (".github/sync/", ".github/workflows/sync-moscoding.yml")


def files(root: Path):
    out = []
    for p in root.rglob("*"):
        rel = p.relative_to(root)
        if p.is_file() and rel.parts[0] != ".git" and not rel.as_posix().startswith(SYNC):
            out.append(rel)
    return sorted(out)


def rebrand(text: str) -> str:
    for rx, repl in RULES:
        text = rx.sub(repl, text)
    return text


def git(repo, *args, env=None, input=None, check=True):
    import os
    run = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, input=input,
                         env={**os.environ, **(env or {})})
    if check and run.returncode:
        raise RuntimeError(f"git {' '.join(args)}: {run.stderr.strip()}")
    return run.stdout


def rebuild_bundle(src: Path, dst: Path):
    """Пересобирает git-архив с заменой имени в файлах и сообщениях коммитов.

    Автор, коммитер и даты сохраняются, поэтому при одинаковом наборе архив выходит тем же
    (одинаковые хеши коммитов) и копия не меняется зря. Пример — client-site/site.bundle
    в vibecoding-kit: учебный проект «Отскок», который ученик разворачивает из архива.
    """
    with tempfile.TemporaryDirectory() as tmp:
        old, new, work = Path(tmp, "old"), Path(tmp, "new"), Path(tmp, "work")
        subprocess.run(["git", "clone", "-q", "--mirror", str(src), str(old)], check=True, capture_output=True)
        subprocess.run(["git", "init", "-q", str(new)], check=True)
        heads = git(old, "for-each-ref", "--format=%(refname)", "refs/heads").split()
        mapped = {}
        for commit in git(old, "rev-list", "--reverse", "--topo-order", *heads).split():
            shutil.rmtree(work, ignore_errors=True)
            work.mkdir()
            git(old, f"--work-tree={work}", "checkout", "-f", commit, "--", ".")
            for path in work.rglob("*"):
                if path.is_file():
                    try:
                        path.write_text(rebrand(path.read_text(encoding="utf-8")), encoding="utf-8")
                    except UnicodeDecodeError:
                        pass
            index = {"GIT_INDEX_FILE": str(Path(tmp, "index"))}
            git(new, f"--work-tree={work}", "add", "-A", ".", env=index)
            tree = git(new, "write-tree", env=index).strip()
            Path(tmp, "index").unlink()
            meta = git(old, "show", "-s", "--format=%an%x00%ae%x00%ad%x00%cn%x00%ce%x00%cd", "--date=raw", commit)
            an, ae, ad, cn, ce, cd = meta.strip("\n").split("\x00")
            parents = [arg for p in git(old, "show", "-s", "--format=%P", commit).split() for arg in ("-p", mapped[p])]
            # %B печатает сообщение с лишним переводом строки в конце; в коммите он ровно один.
            message = rebrand(git(old, "show", "-s", "--format=%B", commit)).rstrip("\n") + "\n"
            mapped[commit] = git(new, "commit-tree", tree, *parents, input=message, env={
                "GIT_AUTHOR_NAME": an, "GIT_AUTHOR_EMAIL": ae, "GIT_AUTHOR_DATE": ad,
                "GIT_COMMITTER_NAME": cn, "GIT_COMMITTER_EMAIL": ce, "GIT_COMMITTER_DATE": cd}).strip()
        for ref in heads:
            git(new, "update-ref", ref, mapped[git(old, "rev-parse", ref).strip()])
        git(new, "bundle", "create", str(Path(tmp, "out.bundle")), *heads)
        shutil.copyfile(Path(tmp, "out.bundle"), dst)


def bundle_leftovers(path: Path):
    """Имя Guide DAO внутри git-архива: в файлах, авторах и сообщениях коммитов."""
    with tempfile.TemporaryDirectory() as tmp:
        repo = f"{tmp}/b"
        subprocess.run(["git", "clone", "-q", "--mirror", str(path), repo], check=True, capture_output=True)
        log = git(repo, "log", "--all", "--format=%an %ae %cn %ce %B")
        revs = git(repo, "rev-list", "--all").split()
        # git grep по всем коммитам: «ревизия:файл:число совпадений»; код выхода 1 — совпадений нет.
        grep = git(repo, "grep", "-I", "-i", "-c", "-E", "guide ?dao", *revs, check=False) if revs else ""
    return [m.group(0) for m in LEFTOVER.finditer(log)] + grep.split()


def main():
    if sys.argv[1:] == ["--message"]:
        text = rebrand(sys.stdin.read())
        if LEFTOVER.search(text):
            print("В сообщении коммита осталось имя Guide DAO — допишите правило в RULES.", file=sys.stderr)
            sys.exit(1)
        print(text.strip())
        return
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    src, dst = (Path(a).resolve() for a in sys.argv[1:])
    if not (dst / ".git").exists():
        print(f"{dst}: нужна папка клона копии (с .git)")
        sys.exit(2)
    wanted = set(files(src))
    for rel in set(files(dst)) - wanted:
        (dst / rel).unlink()
    leftovers = []
    for rel in sorted(wanted):
        target = dst / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        data = (src / rel).read_bytes()
        # Архив без имени Guide DAO копируется как есть: пересборка дала бы те же коммиты, но другие байты.
        if rel.suffix == ".bundle" and bundle_leftovers(src / rel):
            rebuild_bundle(src / rel, target)
            leftovers += [f"{rel} (внутри архива): {found}" for found in bundle_leftovers(target)]
        else:
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError:
                target.write_bytes(data)
            else:
                text = rebrand(text)
                leftovers += [f"{rel}: {m.group(0)}" for m in LEFTOVER.finditer(text)]
                target.write_bytes(text.encode("utf-8"))
        shutil.copymode(src / rel, target)
    for path in sorted(dst.rglob("*"), reverse=True):
        if path.is_dir() and path.relative_to(dst).parts[0] != ".git" and not any(path.iterdir()):
            path.rmdir()
    if leftovers:
        print("В копии осталось имя Guide DAO — допишите правило в RULES:")
        print("\n".join(leftovers))
        sys.exit(1)


if __name__ == "__main__":
    main()
