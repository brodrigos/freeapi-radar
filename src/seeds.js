// Conhecimento de domínio: endpoints conhecidos e pontos de partida da descoberta.
// Nada aqui é "confiável por decreto" — o verificador testa cada um ao vivo.

export const KNOWN_ENDPOINTS = {
  'openrouter.ai': { label: 'OpenRouter', apiBase: 'https://openrouter.ai/api/v1', compat: true, note: 'modelos com pricing zero' },
  'groq.com': { label: 'Groq', apiBase: 'https://api.groq.com/openai/v1', compat: true, note: 'free tier generoso' },
  'cerebras.ai': { label: 'Cerebras', apiBase: 'https://api.cerebras.ai/v1', compat: true, note: 'free tier por dia' },
  'mistral.ai': { label: 'Mistral AI', apiBase: 'https://api.mistral.ai/v1', compat: true, note: 'plano gratuito La Plateforme' },
  'google.com': { label: 'Google Gemini', apiBase: 'https://generativelanguage.googleapis.com/v1beta/openai', compat: true, note: 'free tier do AI Studio' },
  'deepseek.com': { label: 'DeepSeek', apiBase: 'https://api.deepseek.com/v1', compat: true, note: 'sem free tier (controle)' },
  'together.xyz': { label: 'Together AI', apiBase: 'https://api.together.xyz/v1', compat: true, note: 'créditos iniciais' },
  'huggingface.co': { label: 'Hugging Face', apiBase: 'https://router.huggingface.co/v1', compat: true, note: 'créditos mensais' },
  'llm7.io': { label: 'LLM7.io', apiBase: 'https://api.llm7.io/v1', compat: true, note: 'acesso livre sem chave' },
  'pollinations.ai': { label: 'Pollinations', apiBase: 'https://text.pollinations.ai/openai', compat: true, note: 'sem chave' },
  'haimaker.ai': { label: 'Haimaker', apiBase: 'https://api.haimaker.ai/v1', compat: true, note: 'free windows rotativas' },
  'chutes.ai': { label: 'Chutes', apiBase: 'https://llm.chutes.ai/v1', compat: true, note: 'free tier' },
  'novita.ai': { label: 'Novita', apiBase: 'https://api.novita.ai/v3/openai', compat: true, note: 'créditos' },
  'sambanova.ai': { label: 'SambaNova', apiBase: 'https://api.sambanova.ai/v1', compat: true, note: 'free tier' },
  'cohere.com': { label: 'Cohere', apiBase: 'https://api.cohere.com/compatibility/v1', compat: true, note: 'trial key' },
  'bigmodel.cn': { label: 'Z.ai (Zhipu)', apiBase: 'https://open.bigmodel.cn/api/paas/v4', compat: true, note: 'modelos gratuitos' },
  'modelscope.cn': { label: 'ModelScope', apiBase: 'https://api-inference.modelscope.cn/v1', compat: true, note: 'quota diária' },
  'nvidia.com': { label: 'NVIDIA NIM', apiBase: 'https://integrate.api.nvidia.com/v1', compat: true, note: 'free credits' },
  'glhf.chat': { label: 'GLHF.chat', apiBase: 'https://glhf.chat/api/openai/v1', compat: true, note: 'modelos free' },
  'ollama.com': { label: 'Ollama Cloud', apiBase: 'https://ollama.com/v1', compat: true, note: 'cloud free tier' },
  'siliconflow.cn': { label: 'SiliconFlow', apiBase: 'https://api.siliconflow.cn/v1', compat: true, note: 'modelos gratuitos' },
};

// Hosts que nunca são provedores de API (repositórios, hospedagem, blogs, redes).
export const BLOCKED_HOSTS = [
  'github.com',
  'github.io',
  'raw.githubusercontent.com',
  'vercel.app',
  'netlify.app',
  'herokuapp.com',
  'pages.dev',
  'news.ycombinator.com',
  'reddit.com',
  'x.com',
  'twitter.com',
  'youtube.com',
  'medium.com',
  'substack.com',
  'linkedin.com',
  'facebook.com',
  'instagram.com',
  'docs.google.com',
  'notion.site',
];

// Sementes de descoberta: onde procurar "casos como esse".
export const SOURCES = {
  awesomeRepo: 'mnfst/awesome-free-llm-apis',
  curatedRepos: ['cheahjs/free-llm-api-resources'],
  githubQueries: [
    '"free llm api" in:name,description,readme',
    '"free llm apis" in:name,description,readme',
    'topic:free-llm-api',
  ],
  hnQueries: ['free llm api', 'free llm api key', 'free tier llm'],
  // Hosts que sempre merecem visita a /free e /pricing (onde mora a "janela grátis").
  alwaysProbe: ['haimaker.ai', 'openrouter.ai'],
  probeLimit: 20,
};
