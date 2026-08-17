---
name: docs-sync
description: Use when code structure, endpoints, models, or conventions changed and docs/ or .claude/skills may be stale. Syncs documentation with reality.
---

# docs-sync

1. Diff das mudanças recentes: `git log --stat -10` + `git diff HEAD~5 --name-only` (ajuste o range).
2. Confronte com `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` e skills em `.claude/skills/`.
3. Atualize o que divergiu: rotas novas, modelos, padrões alterados. Adicione ADR se houve decisão nova.
4. Commit separado `docs: sync com <mudança>`.
Nunca deixe exemplo de código nos docs apontando para arquivo que não existe mais.
