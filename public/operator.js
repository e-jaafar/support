import { api, renderMessages, select, statuses } from '/ui.js';

const login = select('#login');
const inbox = select('#inbox');
const logout = select('#logout');
const feedback = select('#operator-feedback');
const close = select('#close-ticket');
const reply = select('#reply');
const tickets = select('#tickets');
const messages = select('#messages');
let token;
let selected;
let ticket;
let refreshTimer;
let busy = false;

function showTicket(next) {
  ticket = next;
  select('#ticket-title').textContent = `Dossier ${next.id.slice(0, 8)}`;
  select('#ticket-status').textContent = statuses[next.status];
  close.hidden = select('#reply-controls').hidden = next.status === 'closed';
  renderMessages(messages, next.messages, 'operator');
}

function showQueue(list) {
  tickets.replaceChildren();
  if (!list.length) {
    const empty = document.createElement('li');
    empty.className = 'aside-copy';
    empty.textContent = 'Aucun dossier ouvert.';
    tickets.append(empty);
  }
  for (const entry of list) {
    const row = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.id = entry.id;
    button.setAttribute('aria-pressed', String(selected === entry.id));
    const label = document.createElement('strong');
    label.textContent = `Dossier ${entry.id.slice(0, 8)}`;
    const status = document.createElement('span');
    status.textContent = statuses[entry.status];
    const preview = document.createElement('small');
    preview.textContent = entry.preview ?? 'Conversation transmise';
    button.append(label, status, preview);
    row.append(button);
    tickets.append(row);
  }
}

function disconnect() {
  token = undefined;
  selected = undefined;
  ticket = undefined;
  clearTimeout(refreshTimer);
  inbox.hidden = logout.hidden = true;
  login.hidden = false;
  close.hidden = select('#reply-controls').hidden = true;
  select('#ticket-title').textContent = 'Choisissez un dossier';
  select('#ticket-status').textContent = '';
  select('#response').value = '';
  messages.replaceChildren();
  tickets.replaceChildren();
  select('#token').focus();
}

async function refresh() {
  const current = token;
  if (!current) return;
  clearTimeout(refreshTimer);
  try {
    const queue = await api('/api/operator/tickets', { token: current });
    if (current !== token) return;
    const focused = document.activeElement?.dataset.id;
    showQueue(queue.tickets);
    if (focused) tickets.querySelector(`[data-id="${focused}"]`)?.focus();
    const id = selected;
    if (id && !busy) {
      const next = await api(`/api/operator/tickets/${id}`, { token: current });
      if (id === selected && current === token && !busy && (!ticket || next.messages.at(-1).id >= ticket.messages.at(-1).id)) {
        showTicket(next);
      }
    }
  } catch (error) {
    if (current !== token) return;
    if (error.status === 401) disconnect();
    feedback.textContent = error.status ? error.message : 'Connexion interrompue.';
    if (error.status === 404) {
      selected = undefined;
      ticket = undefined;
      messages.replaceChildren();
      select('#ticket-title').textContent = 'Choisissez un dossier';
      select('#ticket-status').textContent = '';
      close.hidden = select('#reply-controls').hidden = true;
    }
  } finally {
    if (current === token) {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refresh, 2500);
    }
  }
}

login.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = login.querySelector('button');
  button.disabled = true;
  const field = select('#token');
  const candidate = field.value.trim();
  try {
    if (!candidate || !/^[\x21-\x7E]+$/.test(candidate)) {
      feedback.textContent = 'Saisissez le jeton opérateur.';
      return;
    }
    const queue = await api('/api/operator/tickets', { token: candidate });
    token = candidate;
    field.value = '';
    login.hidden = true;
    inbox.hidden = logout.hidden = false;
    feedback.textContent = '';
    showQueue(queue.tickets);
    refreshTimer = setTimeout(refresh, 2500);
  } catch (error) {
    feedback.textContent = error.status ? error.message : 'Connexion interrompue.';
  } finally {
    button.disabled = false;
  }
});
logout.addEventListener('click', () => {
  disconnect();
  feedback.textContent = '';
});
tickets.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-id]');
  if (!button || busy || selected === button.dataset.id) return;
  selected = button.dataset.id;
  ticket = undefined;
  close.hidden = select('#reply-controls').hidden = true;
  select('#ticket-title').textContent = 'Chargement du dossier…';
  select('#ticket-status').textContent = '';
  select('#response').value = '';
  feedback.textContent = '';
  messages.replaceChildren();
  refresh();
});

async function act(body) {
  if (!token || !ticket || busy) return false;
  busy = true;
  const current = token;
  reply.querySelector('button').disabled = close.disabled = logout.disabled = true;
  try {
    showTicket(await api(`/api/operator/tickets/${selected}`, { token: current, body }));
    feedback.textContent = '';
    return true;
  } catch (error) {
    feedback.textContent = error.status ? error.message : 'Connexion interrompue. Vérifiez le dossier avant de réessayer.';
    return false;
  } finally {
    busy = false;
    reply.querySelector('button').disabled = close.disabled = logout.disabled = false;
    refresh();
  }
}

reply.addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = select('#response');
  if (await act({ action: 'reply', text: input.value })) input.value = '';
});
close.addEventListener('click', () => act({ action: 'close' }));
