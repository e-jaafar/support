export const select = (selector) => document.querySelector(selector);

export async function api(path, { body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error);
    error.status = response.status;
    throw error;
  }
  return result;
}

export const statuses = {
  assistant: 'Assistant automatique',
  queued: 'En attente d’un conseiller',
  human: 'Conseiller en conversation',
  closed: 'Dossier clôturé',
};

const names = {
  assistant: 'Assistant Sillage',
  client: 'Client',
  operator: 'Équipe support',
  system: 'Suivi du dossier',
};
const clock = new Intl.DateTimeFormat('fr', { hour: '2-digit', minute: '2-digit' });

export function renderMessages(container, messages, perspective) {
  const known = Number(container.lastElementChild?.dataset.id);
  const from = messages.findIndex((message) => message.id === known) + 1;
  if (from === messages.length && from > 0) return;
  const atEnd = !from || container.scrollHeight - container.clientHeight - container.scrollTop < 70;
  if (!from) container.replaceChildren();
  for (const message of messages.slice(from)) {
    const entry = document.createElement('article');
    entry.className = `message ${message.role === perspective ? 'own' : ''} ${message.role}`;
    entry.dataset.id = message.id;
    const label = document.createElement('div');
    label.className = 'message-meta';
    const sender = document.createElement('strong');
    sender.textContent = message.role === perspective ? 'Vous' : names[message.role];
    const date = new Date(message.created);
    const time = document.createElement('time');
    time.dateTime = date.toISOString();
    time.textContent = clock.format(date);
    label.append(sender, time);
    const text = document.createElement('p');
    text.textContent = message.text;
    entry.append(label, text);
    container.append(entry);
  }
  if (atEnd || messages.at(-1)?.role === perspective) container.scrollTop = container.scrollHeight;
}
