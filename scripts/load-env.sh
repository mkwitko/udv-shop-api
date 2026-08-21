#!/usr/bin/env bash
# Carrega o .env para o ambiente sem passar pelo shell.
#
# `set -a && source .env` parece equivalente e não é: valor com `<`, `>`, `|` ou `&` — e o
# .env.example traz `EMAIL_FROM=Colheita <nao-responda@colheita.app>` — faz o bash tratar o
# caractere como redirecionamento e estourar com "syntax error near unexpected token".
# Pior: o erro não interrompe o `source`, então tudo abaixo da linha ruim simplesmente não
# carrega, e o script segue com variável vazia.
#
# O docker compose não sofre disso porque usa parser de dotenv próprio, o que faz o defeito
# aparecer só nos scripts de host.
#
# Uso: source "$(dirname "${BASH_SOURCE[0]}")/load-env.sh"; load_env .env

load_env() {
  local file="${1:-.env}" line key value
  [[ -r "$file" ]] || {
    echo "load_env: $file ilegível" >&2
    return 1
  }
  while IFS= read -r line || [[ -n "$line" ]]; do
    # comentário e linha em branco
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    # ignora o que não é nome de variável (linha de continuação, lixo)
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    # tira aspas envolventes, se quem editou o arquivo pôs
    if [[ ${#value} -ge 2 ]]; then
      if [[ "$value" == \"*\" ]] || [[ "$value" == \'*\' ]]; then
        value="${value:1:${#value}-2}"
      fi
    fi
    export "${key}=${value}"
  done <"$file"
}
