// Exporta os candidatos verificados como model_list do LiteLLM (gateway do usuário).

const aliasFor = (key) => `radar-${key.split('.')[0].replace(/[^a-z0-9]/gi, '')}`;

export function toLiteLLM(records, { onlyVerified = true } = {}) {
  const lines = [
    '# Gerado por freeapi-radar — revise antes de colar no config.yaml do gateway.',
    '# model: openai/<id> funciona para qualquer endpoint OpenAI-compatível.',
    '# api_key: os.environ/<VAR> exige a variável no ambiente do container.',
    'model_list:',
  ];

  const usable = records
    .filter((r) => r.compat && r.apiBase)
    .filter((r) => !onlyVerified || r.verification?.api?.status === 200 || r.verification?.api?.authRequired);

  if (!usable.length) {
    lines.push('  [] # nenhum endpoint verificado nesta execução');
    return lines.join('\n');
  }

  for (const r of usable) {
    const envVar = `${r.key.split('.')[0].replace(/[^a-z0-9]/gi, '_').toUpperCase()}_API_KEY`;
    const model = r.models?.[0] ?? 'auto';
    lines.push(
      `  - model_name: ${aliasFor(r.key)}`,
      '    litellm_params:',
      `      model: openai/${model}`,
      `      api_base: ${r.apiBase}`,
      `      api_key: os.environ/${envVar}`,
      `    model_info:`,
      `      notes: "${(r.verification?.summary ?? r.freeKind ?? '').replace(/"/g, "'")} | score ${r.score}${r.tier}"`,
    );
  }
  return lines.join('\n');
}
