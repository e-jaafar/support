import { api, renderMessages, select, statuses } from '/ui.js';

const input = select('#message');
const send = select('#composer button');
const handoff = select('#handoff');
const confirm = select('#confirm');
const feedback = select('#feedback');
let snapshot;
let events;
let busy = false;

function controls() {
  const unavailable = !snapshot || busy;
  input.disabled = send.disabled = unavailable;
  handoff.disabled = unavailable || ['queued', 'human'].includes(snapshot?.status);
  for (const button of document.querySelectorAll('[data-message]')) button.disabled = unavailable;
}

function show(next) {
  if (snapshot && snapshot.id !== next.id) {
    if (events) events.close();
    location.reload();
    return;
  }
  if (snapshot && snapshot.messages.at(-1).id > next.messages.at(-1).id) return;
  snapshot = next;
  select('#status').textContent = statuses[next.status];
  select('#suggestions').hidden = ['queued', 'human'].includes(next.status);
  renderMessages(select('#messages'), next.messages, 'client');
  controls();
}

function connection(online) {
  const label = select('#connection');
  label.classList.toggle('online', online);
  label.lastElementChild.textContent = online ? 'En direct' : 'Reconnexion…';
}

async function submit(path, body) {
  if (!snapshot || busy) return false;
  busy = true;
  controls();
  feedback.textContent = path === '/api/message' ? 'Envoi…' : 'Transmission…';
  try {
    show(await api(path, { body }));
    feedback.textContent = '';
    return true;
  } catch (error) {
    feedback.textContent = error.status ? error.message : 'Connexion interrompue. Vérifiez si le message apparaît avant de réessayer.';
    return false;
  } finally {
    busy = false;
    controls();
  }
}

select('#composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!input.value.trim()) return;
  if (await submit('/api/message', { text: input.value })) input.value = '';
  input.focus();
});
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-message]');
  if (!button || button.disabled) return;
  const sent = await submit('/api/message', { text: button.dataset.message });
  if (sent && button.closest('#orders')) select('#messages').scrollIntoView({ block: 'nearest' });
});
handoff.addEventListener('click', () => confirm.showModal());
confirm.addEventListener('close', async () => {
  const accepted = confirm.returnValue === 'confirm';
  confirm.returnValue = '';
  if (accepted && await submit('/api/handoff', { confirmed: true })) {
    select('#messages').scrollIntoView({ block: 'nearest' });
  }
});

function connect() {
  const source = new EventSource('/api/events');
  events = source;
  source.addEventListener('open', () => connection(true));
  source.addEventListener('error', () => {
    connection(false);
    if (source.readyState === EventSource.CLOSED) {
      feedback.textContent = 'Connexion en direct interrompue. Actualisez la page pour la rétablir.';
    }
  });
  source.addEventListener('conversation', async ({ data }) => {
    if (Number(data) <= snapshot.messages.at(-1).id) return;
    try {
      show(await api('/api/session'));
    } catch {
      if (events !== source) return;
      source.close();
      events = undefined;
      connection(false);
      setTimeout(connect, 3000);
    }
  });
}

async function start() {
  controls();
  try {
    const initial = await api('/api/session');
    if (initial.aiEnabled) select('#privacy').textContent += ' Certaines questions peuvent être classées par OpenAI.';
    for (const order of initial.orders) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.message = order.ref;
      const title = document.createElement('strong');
      title.textContent = order.product;
      const ref = document.createElement('span');
      ref.textContent = order.ref;
      button.append(title, ref);
      item.append(button);
      select('#orders').append(item);
    }
    show(initial);
    connect();
  } catch (error) {
    feedback.textContent = error.status ? error.message : 'Connexion indisponible. Actualisez la page pour réessayer.';
    connection(false);
  }
}
start();
