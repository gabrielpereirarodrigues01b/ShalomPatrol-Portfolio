// ShalomPatrol — controle de rondas, servidor (Node.js 22.13+; sem npm install)
// Versão de portfólio: seguranças, pontos, escala e horários são fictícios (exemplos para demonstração).
// Iniciar:                     node server.js
// No dia a dia, os coordenadores cuidam de tudo pelo painel: escala, seguranças, PINs e senha (aba Senhas).
// Pelo terminal (só para emergências, por exemplo se a senha da coordenação for esquecida):
//   Novos PINs para TODOS os seguranças: node server.js --reset            (não apaga registros)
//   Trocar senha do coordenador:         node server.js --coord-password   (pede a senha sem mostrá-la)
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const zlib = require('node:zlib'); // compacta a planilha do Excel (um .xlsx é um ZIP)

// ---- Configurações (variáveis de ambiente sobrescrevem os padrões) ----
const PORT = Number(process.env.PORT) || 3000;
const ALLOWED_NETS = (process.env.ALLOWED_NETS || '').split(',').filter(Boolean); // ex.: 192.168.10.
// Seguranças iniciais (ids 1 a 5): usados só na criação do banco. Depois disso, quem adiciona e remove é o coordenador, pelo painel
const GUARD_NAMES = ['Segurança 1', 'Segurança 2', 'Segurança 3', 'Segurança 4', 'Segurança 5'];
// Pontos na ORDEM FIXA da ronda: o 1º abre, o último fecha, e a leitura fora de ordem é recusada.
// As telas dizem "Ir para o <nome>": se um dia entrar um ponto de nome feminino (ex.: Quadra), ajuste o texto em public/ronda.html
const POINTS = ['Ponto A', 'Ponto B', 'Ponto C', 'Ponto D'];
// Escala semanal inicial (1 = segunda): [ronda da manhã, ronda da tarde]
const SCHEDULE = {
  1: ['Segurança 1', 'Segurança 2'], 2: ['Segurança 3', 'Segurança 4'], 3: ['Segurança 5', 'Segurança 1'],
  4: ['Segurança 2', 'Segurança 3'], 5: ['Segurança 4', 'Segurança 5'],
};
const hm = (text) => text.split(':').map(Number);
// Cada ronda abre em "opens" e cada ponto tem um prazo fixo, em minutos depois da abertura:
//   manhã: abre 09:00, prazos 09:10, 09:20, 09:30 e 09:40 (1º, 2º, 3º e 4º ponto)
//   tarde: abre 14:55, prazos 15:00, 15:10, 15:20 e 15:30
// ROUND_MANHA / ROUND_TARDE mudam o horário de abertura para testes (ex.: set ROUND_MANHA=15:20)
const ROUNDS = [
  { id: 'manha', label: 'Ronda das 9h', opens: hm(process.env.ROUND_MANHA || '09:00'), offsets: [10, 20, 30, 40] },
  { id: 'tarde', label: 'Ronda das 15h', opens: hm(process.env.ROUND_TARDE || '14:55'), offsets: [5, 15, 25, 35] },
];
const GRACE_MIN = 120; // depois do último prazo ainda aceita leituras por 2 h (ficam como "ponto batido com atraso")
// A aba Registros começa no dia em que o banco foi criado (ou na data de RECORDS_FROM, se definida)
if (process.env.RECORDS_FROM && !/^\d{4}-\d{2}-\d{2}$/.test(process.env.RECORDS_FROM)) { console.error('RECORDS_FROM inválido. Use AAAA-MM-DD, por exemplo 2026-03-02.'); process.exit(1); }
const SESSION_MS = 12 * 3600 * 1000;

// ---- Banco de dados (arquivo rondas.db ao lado do server.js) ----
const DB_FILE = path.join(__dirname, 'rondas.db');
const db = new DatabaseSync(DB_FILE);
db.exec(`
CREATE TABLE IF NOT EXISTS guards (id INTEGER PRIMARY KEY, name TEXT, pin_hash TEXT, active INTEGER DEFAULT 1, pin_changed_at INTEGER);
CREATE TABLE IF NOT EXISTS points (id INTEGER PRIMARY KEY, name TEXT, token TEXT UNIQUE, active INTEGER DEFAULT 1, pos INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS checkins (id INTEGER PRIMARY KEY, guard_id INTEGER, point_id INTEGER, ts INTEGER);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS schedule (weekday INTEGER, shift TEXT, guard_id INTEGER, PRIMARY KEY (weekday, shift));
CREATE TABLE IF NOT EXISTS day_schedule (day TEXT, shift TEXT, guard_id INTEGER, PRIMARY KEY (day, shift));
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, ts INTEGER, ip TEXT, action TEXT);
CREATE INDEX IF NOT EXISTS idx_checkins_ts ON checkins(ts);
`);
// Atualiza bancos criados por versões anteriores (sem apagar nada)
const addColumn = (table, column, def) => {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
};
addColumn('guards', 'name', 'TEXT');
addColumn('guards', 'active', 'INTEGER DEFAULT 1'); // 0 = segurança removido (não entra mais; os registros antigos continuam)
addColumn('guards', 'pin_changed_at', 'INTEGER'); // quando o PIN atual foi gerado
addColumn('points', 'active', 'INTEGER DEFAULT 1');
addColumn('points', 'pos', 'INTEGER DEFAULT 0');
const getSetting = (key) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) || {}).value;
const setSetting = (key, value) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));

// Seguranças: a lista inicial só entra em banco novo. Depois disso o servidor não mexe mais em nomes (quem cuida é o painel)
if (!db.prepare('SELECT 1 FROM guards').get()) {
  GUARD_NAMES.forEach((name, i) => db.prepare('INSERT INTO guards (id, name) VALUES (?, ?)').run(i + 1, name));
}
// Primeiro dia dos registros: gravado na criação do banco
if (!getSetting('records_from')) {
  const d = new Date();
  setSetting('records_from', [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-'));
}
const RECORDS_FROM = process.env.RECORDS_FROM || getSetting('records_from');

// Pontos ativos = a lista POINTS, nessa ordem. Os que saírem da lista ficam desativados (o histórico é mantido); os novos ganham token de QR code
db.exec('UPDATE points SET active = 0');
POINTS.forEach((name, i) => {
  const p = db.prepare('SELECT id FROM points WHERE name = ?').get(name);
  if (p) db.prepare('UPDATE points SET active = 1, pos = ? WHERE id = ?').run(i, p.id);
  else db.prepare('INSERT INTO points (name, token, active, pos) VALUES (?, ?, 1, ?)').run(name, crypto.randomBytes(9).toString('base64url'), i);
});
if (!db.prepare('SELECT 1 FROM schedule').get()) {
  for (const [day, [morning, afternoon]] of Object.entries(SCHEDULE)) {
    db.prepare('INSERT INTO schedule VALUES (?, ?, ?)').run(Number(day), 'manha', GUARD_NAMES.indexOf(morning) + 1);
    db.prepare('INSERT INTO schedule VALUES (?, ?, ?)').run(Number(day), 'tarde', GUARD_NAMES.indexOf(afternoon) + 1);
  }
}

// ---- Senhas: nunca guardamos PIN nem senha em texto puro (scrypt + sal) ----
const hash = (secret) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(String(secret), salt, 32).toString('hex');
};
const verify = (secret, stored) => {
  const [salt, h] = (stored || ':').split(':');
  const test = crypto.scryptSync(String(secret), salt, 32);
  const real = Buffer.from(h, 'hex');
  return real.length === test.length && crypto.timingSafeEqual(real, test);
};
const setCoordPassword = (password) => setSetting('coord', hash(password));

// Sorteia um PIN de 4 dígitos, guarda só o hash e devolve o PIN para ser mostrado UMA vez (o PIN anterior deixa de valer)
const newPin = (guardId) => {
  const pin = String(crypto.randomInt(0, 10000)).padStart(4, '0');
  db.prepare('UPDATE guards SET pin_hash = ?, pin_changed_at = ? WHERE id = ?').run(hash(pin), Date.now(), guardId);
  return pin;
};
// PINs no terminal: sorteia só para quem ainda não tem (ou para todos os seguranças ativos, com --reset)
function issuePins(all) {
  const rows = db.prepare('SELECT id, name FROM guards WHERE active = 1 AND (? = 1 OR pin_hash IS NULL)').all(all ? 1 : 0);
  if (rows.length) console.log('\n=== PINs DOS SEGURANÇAS (anote agora; não serão exibidos de novo) ===');
  for (const g of rows) console.log(`${g.name}: PIN ${newPin(g.id)}`);
}
issuePins(process.argv.includes('--reset'));
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'coord'").get()) {
  const password = crypto.randomBytes(6).toString('base64url');
  setCoordPassword(password);
  console.log(`\nCOORDENADORES: senha provisória ${password}`);
  console.log('Troque a senha com: node server.js --coord-password\n');
}
if (process.argv.includes('--reset')) process.exit(0);

// Lê a senha mostrando um * por caractere (a senha em si nunca aparece na tela)
function askHidden(question) {
  return new Promise((resolve) => {
    if (!process.stdin.setRawMode) {
      console.log('Este terminal não permite digitar a senha. Use: set "COORD_PASSWORD=SUA_SENHA" e rode o comando de novo.');
      process.exit(1);
    }
    process.stdout.write(question);
    let typed = '', lastWasCR = false;
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
    const onKey = (chunk) => {
      for (const ch of chunk) {
        const afterCR = lastWasCR; lastWasCR = ch === '\r';
        if (ch === '\n' && afterCR) continue; // alguns terminais enviam o Enter como \r\n
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onKey); process.stdout.write('\n');
          return resolve(typed);
        }
        if (ch === '\u0003') process.exit(1); // Ctrl+C
        if (ch === '\u007f' || ch === '\b') { if (typed) { typed = typed.slice(0, -1); process.stdout.write('\b \b'); } }
        else if (ch >= ' ') { typed += ch; process.stdout.write('*'); }
      }
    };
    process.stdin.on('data', onKey);
  });
}
async function askNewPassword() {
  if (process.env.COORD_PASSWORD) return process.env.COORD_PASSWORD; // modo sem digitação
  console.log('Digite a nova senha. Aparece um * para cada caractere; a senha em si não aparece.');
  for (let attempt = 0; attempt < 3; attempt++) {
    const first = await askHidden('Nova senha do coordenador: ');
    if (!first) { console.log('A senha não pode ser vazia.\n'); continue; }
    if (first !== await askHidden('Repita a senha: ')) { console.log('As senhas não conferem. Tente de novo.\n'); continue; }
    if (first.length < 8) console.log('AVISO: senha com menos de 8 caracteres é fácil de adivinhar.');
    return first;
  }
  console.log('Nada foi alterado.');
  process.exit(1);
}

// ---- Sessões (em memória; ao reiniciar o servidor, todos entram de novo) ----
const sessions = new Map(); // token -> { role, guardId, exp }
setInterval(() => { for (const [k, v] of sessions) if (v.exp < Date.now()) sessions.delete(k); }, 3600 * 1000).unref();
function getSession(req) {
  const m = /(?:^|;\s*)sid=([\w-]+)/.exec(req.headers.cookie || '');
  const s = m && sessions.get(m[1]);
  return s && s.exp > Date.now() ? s : null;
}
function startSession(res, data) {
  const sid = crypto.randomBytes(24).toString('base64url');
  sessions.set(sid, { ...data, exp: Date.now() + SESSION_MS });
  // Se o site passar a usar HTTPS, acrescente "; Secure" neste cookie
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
}

function endSession(req, res) {
  const m = /(?:^|;\s*)sid=([\w-]+)/.exec(req.headers.cookie || '');
  if (m) sessions.delete(m[1]);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  send(res, 200, { ok: true });
}
// Derruba sessões abertas (PIN trocado, segurança removido ou senha da coordenação trocada)
const dropSessions = (match) => { for (const [sid, s] of sessions) if (match(s)) sessions.delete(sid); };

// ---- Bloqueio após 5 erros, por IP (assim ninguém tranca o login dos outros) ----
const fails = new Map(); // chave -> { n, until }
const isLocked = (key) => (fails.get(key)?.until || 0) > Date.now();
const addFail = (key) => {
  const f = fails.get(key) || { n: 0, until: 0 };
  if (++f.n >= 5) { f.n = 0; f.until = Date.now() + 300000; }
  fails.set(key, f);
};

// ---- Utilitários ----
const send = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};
const readJson = (req) => new Promise((resolve) => {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 5000) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
});
const clientIp = (req) => (req.socket.remoteAddress || '').replace('::ffff:', '');
// Rastro das alterações feitas pelo painel (a senha da coordenação é compartilhada: aqui fica o que mudou, quando e de qual computador).
// Nunca grava PIN nem senha
const audit = (req, action) => {
  db.prepare('INSERT INTO audit (ts, ip, action) VALUES (?, ?, ?)').run(Date.now(), clientIp(req), action);
  console.log(`${new Date().toLocaleString('pt-BR')} [painel ${clientIp(req)}] ${action}`);
};
const onSchoolNet = (ip) => !ALLOWED_NETS.length || ALLOWED_NETS.some((p) => ip.startsWith(p));
const windowOf = (r, day = new Date()) => {
  const opens = new Date(day).setHours(r.opens[0], r.opens[1], 0, 0);
  const deadlines = r.offsets.map((m) => opens + m * 60000);
  return { opens, deadlines, until: deadlines[deadlines.length - 1] + GRACE_MIN * 60000 };
};
const minutesLate = (ts, deadline) => Math.floor(ts / 60000) - Math.floor(deadline / 60000); // compara HH:MM, ignorando os segundos
const scheduledGuard = (weekday, shift) => {
  const s = db.prepare('SELECT guard_id FROM schedule WHERE weekday = ? AND shift = ?').get(weekday, shift);
  return s ? s.guard_id : null;
};
const PAGES = { ronda: 'ronda.html', painel: 'painel.html', qr: 'qr.html' };
const servePage = (res, name) => {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
  });
  res.end(fs.readFileSync(path.join(__dirname, 'public', PAGES[name])));
};
// Logo da instituição: só este arquivo fixo é entregue (nenhum caminho vem do navegador).
// "no-cache" + ETag: o navegador confere a cada visita e só baixa de novo se o arquivo mudou (troca de logo aparece sem Ctrl+F5)
const LOGO_FILE = path.join(__dirname, 'public', 'logo.jpg');
const serveLogo = (req, res) => {
  fs.stat(LOGO_FILE, (statErr, st) => {
    if (statErr) { res.writeHead(404); return res.end(); }
    const etag = `"${st.size}-${Math.floor(st.mtimeMs)}"`;
    const headers = { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache', ETag: etag, 'X-Content-Type-Options': 'nosniff' };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    fs.readFile(LOGO_FILE, (readErr, data) => {
      if (readErr) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { ...headers, 'Content-Length': data.length });
      res.end(data);
    });
  });
};

// ---- Logins ----
async function guardLogin(req, res) {
  const { guard, pin } = await readJson(req);
  const key = `g:${clientIp(req)}:${Number(guard)}`;
  if (isLocked(key)) return send(res, 429, { error: 'Muitas tentativas. Aguarde 5 minutos.' });
  const g = db.prepare('SELECT * FROM guards WHERE id = ? AND active = 1').get(Number(guard));
  if (!g || !verify(pin, g.pin_hash)) { addFail(key); return send(res, 401, { error: 'Nome ou PIN inválido.' }); }
  fails.delete(key);
  startSession(res, { role: 'guard', guardId: g.id });
  send(res, 200, { ok: true });
}
async function coordLogin(req, res) {
  const { password } = await readJson(req);
  const key = `c:${clientIp(req)}`;
  if (isLocked(key)) return send(res, 429, { error: 'Muitas tentativas. Aguarde 5 minutos.' });
  const row = db.prepare("SELECT value FROM settings WHERE key = 'coord'").get();
  if (!verify(password, row && row.value)) { addFail(key); return send(res, 401, { error: 'Senha incorreta.' }); }
  fails.delete(key);
  startSession(res, { role: 'coord' });
  send(res, 200, { ok: true });
}

// ---- Registro da ronda: o horário vem SEMPRE do servidor ----
async function checkin(req, res, session) {
  if (!session || session.role !== 'guard') return send(res, 401, { error: 'Entre com seu nome e PIN.' });
  if (!onSchoolNet(clientIp(req))) return send(res, 403, { error: 'Conecte-se ao Wi-Fi da escola para bater o ponto.' });
  const { token } = await readJson(req);
  const point = db.prepare('SELECT * FROM points WHERE token = ? AND active = 1').get(String(token));
  if (!point) return send(res, 404, { error: 'QR code não reconhecido ou ponto desativado.' });
  const now = Date.now();
  const round = ROUNDS.find((r) => { const w = windowOf(r); return now >= w.opens && now <= w.until; });
  if (!round) {
    const soon = ROUNDS.find((r) => { const w = windowOf(r); return now < w.opens && w.opens - now <= 15 * 60000; });
    const at = (ms) => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return send(res, 403, { error: soon
      ? `A ${soon.label.toLowerCase()} só pode começar a partir das ${at(windowOf(soon).opens)}.`
      : `Fora do horário das rondas (${ROUNDS.map((r) => r.label.replace('Ronda das ', '')).join(' e ')}).` });
  }
  const w = windowOf(round);
  const scheduled = scheduledGuard(new Date().getDay(), round.id);
  if (scheduled !== session.guardId) {
    return send(res, 403, scheduled
      ? { error: 'Você não está escalado para esta ronda.', code: 'not_scheduled' }
      : { error: 'Não há segurança escalado para esta ronda.' });
  }
  const points = db.prepare('SELECT id, name FROM points WHERE active = 1 ORDER BY pos').all();
  const ids = points.map((p) => p.id);
  const guard = db.prepare('SELECT name FROM guards WHERE id = ?').get(session.guardId);
  const base = { ok: true, guard: guard.name, point: point.name, round: round.label, final: point.id === ids[ids.length - 1] }; // o último ponto encerra a ronda
  const mine = db.prepare('SELECT point_id, ts FROM checkins WHERE guard_id = ? AND ts >= ? AND ts <= ? ORDER BY ts').all(session.guardId, w.opens, w.until).filter((c) => ids.includes(c.point_id));
  const done = new Set(mine.map((c) => c.point_id));
  const nextPoint = () => points.find((p) => !done.has(p.id)); // ordem fixa: o próximo é sempre o primeiro ponto ainda não batido
  const nextName = () => (nextPoint() || {}).name || null; // null = não falta nenhum (ronda completa)
  const already = mine.find((c) => c.point_id === point.id);
  if (already) return send(res, 200, { ...base, already: true, ts: already.ts, next: nextName() }); // ponto já batido nesta ronda: não registra de novo
  const expected = nextPoint();
  if (expected.id !== point.id) { // fora da ordem: não registra e diz qual é o ponto certo
    return send(res, 409, { error: `Fora da ordem: o próximo ponto é o ${expected.name}.`, code: 'out_of_order', point: point.name, next: expected.name });
  }
  const rank = done.size; // quantos pontos já foram batidos: este é o ponto de número rank + 1
  db.prepare('INSERT INTO checkins (guard_id, point_id, ts) VALUES (?, ?, ?)').run(session.guardId, point.id, now);
  done.add(point.id);
  send(res, 200, { ...base, already: false, ts: now, late: minutesLate(now, w.deadlines[Math.min(rank, w.deadlines.length - 1)]) > 0, next: nextName() });
}

// ---- Relatório de um dia: situação de cada ronda ----
const dateStr = (d) => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
const parseDay = (text) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text || '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};
// Escala dos dias passados: fica congelada, assim editar a escala nunca muda relatórios antigos
function freezeDay(day) {
  const key = dateStr(day), weekday = day.getDay();
  if (weekday === 0 || weekday === 6 || db.prepare('SELECT 1 FROM day_schedule WHERE day = ?').get(key)) return;
  for (const s of db.prepare('SELECT shift, guard_id FROM schedule WHERE weekday = ?').all(weekday))
    db.prepare('INSERT OR IGNORE INTO day_schedule (day, shift, guard_id) VALUES (?, ?, ?)').run(key, s.shift, s.guard_id);
}
function freezePastDays() { // do primeiro dia dos registros até ontem; roda antes de qualquer edição da escala
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (const d = parseDay(RECORDS_FROM); d < today; d.setDate(d.getDate() + 1)) freezeDay(d);
}
function dayReport(day) {
  const now = Date.now(), weekday = day.getDay();
  const dayStart = new Date(day).setHours(0, 0, 0, 0);
  if (weekday === 0 || weekday === 6) return { dayStart, now, weekend: true, rounds: [], log: [] }; // sem rondas nos fins de semana
  const isPast = dayStart < new Date().setHours(0, 0, 0, 0);
  if (isPast) freezeDay(day);
  const scheduledFor = (shift) => { // dias passados usam a escala congelada; hoje usa a escala atual
    if (!isPast) return scheduledGuard(weekday, shift);
    const f = db.prepare('SELECT guard_id FROM day_schedule WHERE day = ? AND shift = ?').get(dateStr(day), shift);
    return f ? f.guard_id : null;
  };
  const points = db.prepare('SELECT id, name FROM points WHERE active = 1 ORDER BY pos').all();
  const total = points.length, ids = points.map((p) => p.id);
  const pname = Object.fromEntries(points.map((p) => [p.id, p.name]));
  const name = Object.fromEntries(db.prepare('SELECT id, name FROM guards').all().map((g) => [g.id, g.name]));
  const log = db.prepare('SELECT c.ts, c.guard_id AS guard, c.point_id AS pid, p.name AS point FROM checkins c JOIN points p ON p.id = c.point_id WHERE c.ts >= ? AND c.ts < ? ORDER BY c.ts').all(dayStart, dayStart + 86400000);
  const rounds = ROUNDS.map((r) => {
    const w = windowOf(r, day);
    const deadline = (i) => w.deadlines[Math.min(i, w.deadlines.length - 1)]; // prazo do ponto de número i + 1
    const inWindow = log.filter((l) => l.ts >= w.opens && l.ts <= w.until && ids.includes(l.pid));
    const guardId = inWindow.length ? inWindow[0].guard : scheduledFor(r.id); // quem de fato bateu os pontos (só o escalado consegue); sem registros, o escalado
    const mine = inWindow.filter((l) => l.guard === guardId);
    const first = {};
    mine.forEach((l) => { if (!first[l.pid]) first[l.pid] = l.ts; });
    const order = ids.filter((id) => first[id]).sort((a, b) => first[a] - first[b]); // pontos na ordem em que foram batidos
    // o 1º ponto batido vale até o 1º prazo, o 2º até o 2º prazo, e assim por diante (adiantado nunca é problema)
    const steps = order.map((id, i) => ({ name: pname[id], ts: first[id], deadline: deadline(i), lateMin: Math.max(0, minutesLate(first[id], deadline(i))) }));
    const complete = order.length === total;
    const pendingIds = ids.filter((id) => !first[id]); // pontos ainda não batidos, na ordem fixa
    let waiting = null, missing = 0; // waiting: próximo ponto e o prazo dele (ao vivo); missing: pontos que ficaram sem leitura
    if (guardId && !complete) {
      if (now > w.until) missing = total - order.length;
      else if (now >= w.opens) waiting = { point: pname[pendingIds[0]], deadline: deadline(order.length), lateMin: Math.max(0, minutesLate(now, deadline(order.length))) };
    }
    const lateMax = Math.max(0, ...steps.map((s) => s.lateMin), waiting ? waiting.lateMin : 0);
    let state = 'idle'; // idle = ainda sem situação (antes da abertura ou sem segurança escalado)
    if (guardId && (steps.length || now >= w.opens)) state = lateMax || missing ? 'late' : 'ok';
    // hoje a leitura fora de ordem é recusada; isto só marca rondas gravadas antes da ordem fixa
    const orderOk = !complete || order.every((id, i) => id === ids[i]);
    return {
      label: r.label, opens: w.opens, lastDeadline: deadline(total - 1), state, guard: guardId ? name[guardId] : null,
      done: order.length, total, complete, orderOk, steps, pending: pendingIds.map((id) => pname[id]),
      todo: pendingIds.map((id, j) => ({ name: pname[id], deadline: deadline(order.length + j) })), // pontos que faltam, com o prazo de cada um (usado na planilha)
      waiting, missing, lateMax,
    };
  });
  return { dayStart, now, route: points.map((p) => p.name), rounds, log: log.map((l) => ({ ts: l.ts, guard: name[l.guard], point: l.point })) };
}
function history() { // dias úteis desde RECORDS_FROM (no máximo 31 dias)
  const from = parseDay(RECORDS_FROM), out = [];
  const day = new Date(); day.setHours(0, 0, 0, 0);
  for (let i = 0; i < 31 && day >= from; i++, day.setDate(day.getDate() - 1)) {
    if (day.getDay() === 0 || day.getDay() === 6) continue; // sem rondas nos fins de semana
    const rep = dayReport(day);
    out.push({ date: dateStr(day), dayStart: rep.dayStart, rounds: rep.rounds.map(({ label, state, guard, lateMax, missing }) => ({ label, state, guard, lateMax, missing })) });
  }
  return out;
}

// ---- Escala semanal (segunda a sexta, uma ronda de manhã e uma à tarde) ----
// Seguranças ativos, em ordem alfabética (os removidos ficam só no histórico)
const activeGuards = () => db.prepare('SELECT id, name, pin_changed_at AS pinChangedAt FROM guards WHERE active = 1').all()
  .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
const guardNames = () => activeGuards().map(({ id, name }) => ({ id, name })); // só id e nome (é o que a tela de entrada do celular recebe)
const getSchedule = (res) => send(res, 200, {
  rounds: ROUNDS.map((r) => ({ id: r.id, label: r.label })),
  guards: guardNames(),
  rows: db.prepare('SELECT weekday, shift, guard_id AS guard FROM schedule').all(),
});
async function saveSchedule(req, res) {
  const { rows } = await readJson(req);
  const ids = activeGuards().map((g) => g.id);
  const valid = Array.isArray(rows) && rows.every((r) => r.weekday >= 1 && r.weekday <= 5 && ROUNDS.some((x) => x.id === r.shift) && ids.includes(Number(r.guard)));
  if (!valid) return send(res, 400, { error: 'Escala inválida.' });
  for (let d = 1; d <= 5; d++) {
    const day = rows.filter((r) => r.weekday === d).map((r) => Number(r.guard));
    if (new Set(day).size !== day.length) return send(res, 400, { error: 'Cada dia precisa de 2 seguranças diferentes.' });
  }
  freezePastDays(); // relatórios dos dias passados continuam com a escala da época
  db.exec('BEGIN');
  try {
    for (const r of rows) db.prepare('INSERT OR REPLACE INTO schedule VALUES (?, ?, ?)').run(r.weekday, r.shift, Number(r.guard));
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; } // se algo falhar no meio, nada é gravado pela metade
  audit(req, 'Escala semanal salva');
  send(res, 200, { ok: true });
}

// ---- Seguranças e senhas (só o coordenador): adicionar, remover, gerar PIN e trocar a senha da coordenação ----
const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
// Nome: 2 a 30 caracteres, começa com letra; aceita letras, números, espaço, ponto, apóstrofo e hífen.
// Além de padronizar, isso barra < > & " (o nome aparece nas telas e na planilha)
const NAME_OK = /^\p{L}[\p{L}\p{N} .'-]{1,29}$/u;
const MAX_GUARDS = 50;
const getTeam = (res) => send(res, 200, {
  guards: activeGuards(),
  log: db.prepare('SELECT ts, ip, action FROM audit ORDER BY id DESC LIMIT 10').all(), // últimas alterações feitas pelo painel
});
async function addGuard(req, res) {
  const name = String((await readJson(req)).name || '').trim().replace(/\s+/g, ' ');
  if (!NAME_OK.test(name)) return send(res, 400, { error: 'Nome inválido. Use de 2 a 30 caracteres, começando por letra (sem símbolos).' });
  const team = activeGuards();
  const same = team.find((g) => g.name.toLocaleLowerCase('pt-BR') === name.toLocaleLowerCase('pt-BR'));
  if (same) return send(res, 409, { error: `Já existe um segurança chamado ${same.name}. Para diferenciar, use um sobrenome ou uma inicial.` });
  if (team.length >= MAX_GUARDS) return send(res, 400, { error: `O limite é de ${MAX_GUARDS} seguranças.` });
  const id = Number(db.prepare('INSERT INTO guards (name, active) VALUES (?, 1)').run(name).lastInsertRowid);
  const pin = newPin(id); // o PIN volta nesta resposta para ser mostrado uma única vez; no banco fica só o hash
  audit(req, `Segurança adicionado: ${name}`);
  send(res, 200, { ok: true, id, name, pin });
}
const findActiveGuard = (id) => db.prepare('SELECT id, name FROM guards WHERE id = ? AND active = 1').get(Number(id) || 0);
async function removeGuard(req, res) {
  const g = findActiveGuard((await readJson(req)).id);
  if (!g) return send(res, 404, { error: 'Segurança não encontrado.' });
  const used = db.prepare('SELECT weekday, shift FROM schedule WHERE guard_id = ? ORDER BY weekday, shift').all(g.id);
  if (used.length) { // quem está na escala não pode sair: a ronda ficaria sem ninguém
    const where = used.map((u) => `${WEEKDAYS[u.weekday]} (${ROUNDS.find((r) => r.id === u.shift).label.toLowerCase()})`).join(', ');
    return send(res, 409, { error: `${g.name} ainda está na escala: ${where}. Troque por outro segurança antes de remover.` });
  }
  // não apaga a linha: os registros antigos continuam com o nome dele. Só desativa e invalida o PIN
  db.prepare('UPDATE guards SET active = 0, pin_hash = NULL WHERE id = ?').run(g.id);
  dropSessions((s) => s.role === 'guard' && s.guardId === g.id);
  audit(req, `Segurança removido: ${g.name}`);
  send(res, 200, { ok: true, name: g.name });
}
async function resetPin(req, res) {
  const g = findActiveGuard((await readJson(req)).id);
  if (!g) return send(res, 404, { error: 'Segurança não encontrado.' });
  const pin = newPin(g.id);
  dropSessions((s) => s.role === 'guard' && s.guardId === g.id); // quem estava com o PIN antigo entra de novo
  for (const key of [...fails.keys()]) if (key.startsWith('g:') && key.endsWith(`:${g.id}`)) fails.delete(key); // libera um bloqueio por erros de PIN, se houver
  audit(req, `Novo PIN gerado para ${g.name}`);
  send(res, 200, { ok: true, name: g.name, pin });
}
async function changeCoordPassword(req, res, session) {
  const { current, next } = await readJson(req);
  const key = `p:${clientIp(req)}`; // mesmo bloqueio do login: 5 erros da senha atual travam por 5 minutos
  if (isLocked(key)) return send(res, 429, { error: 'Muitas tentativas. Aguarde 5 minutos.' });
  if (typeof next !== 'string' || next.length < 8 || next.length > 100) return send(res, 400, { error: 'A nova senha precisa ter pelo menos 8 caracteres.' });
  if (!verify(current, getSetting('coord'))) { addFail(key); return send(res, 403, { error: 'A senha atual não confere.' }); } // 403 (e não 401): a sessão continua válida
  fails.delete(key);
  if (next === current) return send(res, 400, { error: 'A nova senha precisa ser diferente da atual.' });
  setCoordPassword(next);
  dropSessions((s) => s.role === 'coord' && s !== session); // os outros computadores que estavam no painel entram de novo, com a senha nova
  audit(req, 'Senha da coordenação trocada');
  send(res, 200, { ok: true });
}

// ---- Planilha do Excel (.xlsx) sem instalar nada ----
// Um .xlsx é um arquivo ZIP com alguns XML dentro; aqui montamos os XML e o ZIP usando só o Node.js.
// buildXlsx([{ name: 'Aba', columns: [{ title, type, width }], rows: [[valor, ...]] }]) devolve um Buffer.
// Tipos de coluna: 'text' (texto), 'int' (número), 'date' (objeto Date, vira dd/mm/aaaa),
//                  'time' (instante em ms, vira hh:mm) e 'timeSec' (instante em ms, vira hh:mm:ss).
// Texto seguro para XML: remove caracteres de controle e troca & < > "
const xmlEsc = (text) => String(text).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Índice da coluna -> letra do Excel (0 = A, 25 = Z, 26 = AA)
const colName = (index) => {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};
// O Excel guarda datas como "dias desde 30/12/1899" e horários como fração do dia (0,5 = meio-dia). Sempre no horário local do servidor
const serialDate = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000 + 25569;
const serialTime = (ts, withSeconds) => {
  const d = new Date(ts);
  return (d.getHours() * 3600 + d.getMinutes() * 60 + (withSeconds ? d.getSeconds() : 0)) / 86400;
};

// Estilos (posição na lista cellXfs do styles.xml): 0 normal, 1 cabeçalho, 2 data (à esquerda), 3 hh:mm, 4 hh:mm:ss e 5 número (os três centralizados)
const STYLE = { header: 1, date: 2, time: 3, timeSec: 4, int: 5 };
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="hh:mm"/><numFmt numFmtId="166" formatCode="hh:mm:ss"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF373F92"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="left"/></xf>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center"/></xf>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

// Uma célula. Texto vai como "inlineStr": o Excel trata como texto puro, nunca como fórmula (um nome começado por "=" não é executado)
function cell(ref, type, value) {
  if (value === null || value === undefined || value === '') return '';
  if (type === 'text') return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(value)}</t></is></c>`;
  if (type === 'date') return `<c r="${ref}" s="${STYLE.date}"><v>${serialDate(value)}</v></c>`;
  if (type === 'time') return `<c r="${ref}" s="${STYLE.time}"><v>${serialTime(value, false)}</v></c>`;
  if (type === 'timeSec') return `<c r="${ref}" s="${STYLE.timeSec}"><v>${serialTime(value, true)}</v></c>`;
  return Number.isFinite(Number(value)) ? `<c r="${ref}" s="${STYLE.int}"><v>${Number(value)}</v></c>` : '';
}

// Uma aba: cabeçalho colorido e congelado, filtro em todas as colunas e largura definida por coluna
function sheetXml(sheet, isFirst) {
  const { columns, rows } = sheet;
  const range = `A1:${colName(columns.length - 1)}${rows.length + 1}`;
  const header = columns.map((c, i) => `<c r="${colName(i)}1" s="${STYLE.header}" t="inlineStr"><is><t>${xmlEsc(c.title)}</t></is></c>`).join('');
  const body = rows.map((row, r) =>
    `<row r="${r + 2}">${columns.map((c, i) => cell(`${colName(i)}${r + 2}`, c.type, row[i])).join('')}</row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="${range}"/>
<sheetViews><sheetView workbookViewId="0"${isFirst ? ' tabSelected="1"' : ''}><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 14}" customWidth="1"/>`).join('')}</cols>
<sheetData><row r="1">${header}</row>${body}</sheetData>
<autoFilter ref="${range}"/>
</worksheet>`;
}

// Monta o ZIP: cada arquivo compactado, depois o índice ("diretório central") e o fecho
function zip(files) {
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'), raw = Buffer.from(f.data, 'utf8');
    const data = zlib.deflateRawSync(raw), crc = zlib.crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x0800, 8); entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(dosTime, 12); entry.writeUInt16LE(dosDate, 14); entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(raw.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    central.push(entry, name);
    offset += local.length + name.length + data.length;
  }
  const centralSize = central.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

function buildXlsx(sheets) {
  const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const PKG = 'http://schemas.openxmlformats.org/package/2006';
  const TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
  const files = [
    { name: '[Content_Types].xml', data: `${XML}<Types xmlns="${PKG}/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="${TYPE}.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="${TYPE}.styles+xml"/>` +
      sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${TYPE}.worksheet+xml"/>`).join('') + '</Types>' },
    { name: '_rels/.rels', data: `${XML}<Relationships xmlns="${PKG}/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `${XML}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets>` +
      sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: `${XML}<Relationships xmlns="${PKG}/relationships">` +
      sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${sheets.length + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: STYLES_XML },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s, i === 0) })),
  ];
  return zip(files);
}

// ---- Exportação dos registros: aba "Rondas" (uma linha por ronda) e aba "Pontos" (uma linha por ponto) ----
function exportXlsx(req, res) {
  const q = new URL(req.url, 'http://x').searchParams;
  const from = q.get('from'), to = q.get('to');
  const first = parseDay(from);
  let last = parseDay(to);
  if (!first || !last || dateStr(first) !== from || dateStr(last) !== to) return send(res, 400, { error: 'Escolha a data inicial e a data final.' });
  if (first > last) return send(res, 400, { error: 'A data inicial precisa vir antes da data final.' });
  if (from < RECORDS_FROM) return send(res, 400, { error: `Os registros começam em ${RECORDS_FROM.slice(8)}/${RECORDS_FROM.slice(5, 7)}.` });
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (first > today) return send(res, 400, { error: 'Ainda não há registros nesse período.' });
  if (last > today) last = today; // dias futuros não têm registro
  if ((last - first) / 86400000 > 366) return send(res, 400, { error: 'Escolha um período de até 1 ano.' });
  const status = (r) => (r.state === 'ok' ? 'Em dia' : r.state === 'late' ? 'Atrasado' : r.guard ? 'Aguardando início' : 'Sem segurança escalado');
  const rounds = [], points = [];
  for (const d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) {
    if (d.getDay() === 0 || d.getDay() === 6) continue; // sem rondas nos fins de semana
    const day = new Date(d), weekday = WEEKDAYS[d.getDay()];
    for (const r of dayReport(day).rounds) {
      rounds.push([day, weekday, r.label, r.guard || '', status(r), r.done, r.total, r.missing, r.lateMax]);
      r.steps.forEach((s, i) => points.push([day, weekday, r.label, r.guard || '', i + 1, s.name, s.deadline, s.ts, s.lateMin > 0 ? 'Atrasado' : 'Em dia', s.lateMin]));
      r.todo.forEach((t, j) => points.push([day, weekday, r.label, r.guard || '', r.done + j + 1, t.name, t.deadline, null,
        !r.guard ? 'Sem segurança escalado' : r.missing ? 'Não registrado' : 'Aguardando', null]));
    }
  }
  const file = buildXlsx([
    { name: 'Rondas', rows: rounds, columns: [
      { title: 'Data', type: 'date', width: 12 }, { title: 'Dia da semana', type: 'text', width: 16 }, { title: 'Ronda', type: 'text', width: 16 },
      { title: 'Segurança', type: 'text', width: 18 }, { title: 'Situação', type: 'text', width: 24 }, { title: 'Pontos batidos', type: 'int', width: 15 },
      { title: 'Pontos da ronda', type: 'int', width: 16 }, { title: 'Pontos sem registro', type: 'int', width: 20 }, { title: 'Maior atraso (min)', type: 'int', width: 19 }] },
    { name: 'Pontos', rows: points, columns: [
      { title: 'Data', type: 'date', width: 12 }, { title: 'Dia da semana', type: 'text', width: 16 }, { title: 'Ronda', type: 'text', width: 16 },
      { title: 'Segurança', type: 'text', width: 18 }, { title: 'Ordem', type: 'int', width: 8 }, { title: 'Ponto', type: 'text', width: 20 },
      { title: 'Prazo', type: 'time', width: 9 }, { title: 'Batido às', type: 'timeSec', width: 11 }, { title: 'Situação', type: 'text', width: 24 },
      { title: 'Atraso (min)', type: 'int', width: 13 }] },
  ]);
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="rondas_${from}_a_${dateStr(last)}.xlsx"`,
    'Content-Length': file.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  });
  res.end(file);
}

// ---- Rotas ----
const COORD_ACTIONS = {
  '/api/schedule': saveSchedule,
  '/api/guards/add': addGuard,
  '/api/guards/remove': removeGuard,
  '/api/guards/pin': resetPin,
  '/api/coord-password': changeCoordPassword,
};
function startServer() {
  http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    const session = getSession(req);
    const isCoord = !!session && session.role === 'coord';
    const onlyCoord = (fn) => (isCoord ? fn() : send(res, 401, { error: 'Entre como coordenador.' }));
    try {
      const route = `${req.method} ${pathname}`;
      if (route === 'POST /api/login') return await guardLogin(req, res);
      if (route === 'POST /api/coord-login') return await coordLogin(req, res);
      if (route === 'POST /api/checkin') return await checkin(req, res, session);
      if (route === 'POST /api/logout') return endSession(req, res);
      if (route === 'GET /api/guards') return send(res, 200, guardNames());
      if (route === 'GET /api/status') return onlyCoord(() => send(res, 200, dayReport(new Date())));
      if (route === 'GET /api/day') {
        return onlyCoord(() => {
          const date = new URL(req.url, 'http://x').searchParams.get('date');
          const day = parseDay(date);
          if (!day) return send(res, 400, { error: 'Data inválida.' });
          if (day.getDay() === 0 || day.getDay() === 6) return send(res, 200, { weekend: true, dayStart: day.getTime() });
          if (date < RECORDS_FROM) return send(res, 400, { error: `Os registros começam em ${RECORDS_FROM.slice(8)}/${RECORDS_FROM.slice(5, 7)}.` });
          send(res, 200, dayReport(day));
        });
      }
      if (route === 'GET /api/history') return onlyCoord(() => send(res, 200, { from: RECORDS_FROM, days: history() }));
      if (route === 'GET /api/schedule') return onlyCoord(() => getSchedule(res));
      if (route === 'GET /api/team') return onlyCoord(() => getTeam(res));
      if (route === 'GET /api/export') return onlyCoord(() => exportXlsx(req, res));
      // ações do coordenador que alteram dados (todas exigem a sessão de coordenador)
      if (req.method === 'POST' && Object.hasOwn(COORD_ACTIONS, pathname)) {
        return isCoord ? await COORD_ACTIONS[pathname](req, res, session) : send(res, 401, { error: 'Entre como coordenador.' });
      }
      if (route === 'GET /api/points') {
        return onlyCoord(() => {
          const proto = req.headers['x-forwarded-proto'] || 'http';
          send(res, 200, db.prepare('SELECT name, token FROM points WHERE active = 1 ORDER BY pos').all()
            .map((p) => ({ name: p.name, url: `${proto}://${req.headers.host}/p/${p.token}` })));
        });
      }
      if (req.method === 'GET' && pathname.startsWith('/p/')) return servePage(res, 'ronda');
      if (route === 'GET /logo.jpg') return serveLogo(req, res);
      if (route === 'GET /qr') return servePage(res, 'qr');
      if (route === 'GET /') return servePage(res, 'painel');
      send(res, 404, { error: 'Não encontrado.' });
    } catch (err) {
      console.error(err);
      send(res, 500, { error: 'Erro interno.' });
    }
  }).listen(PORT, () => {
    console.log(`ShalomPatrol em http://localhost:${PORT}`);
    if (!ALLOWED_NETS.length) console.warn('AVISO: ALLOWED_NETS vazio — o registro aceita qualquer rede. Defina, ex.: ALLOWED_NETS=192.168.10.');
  });
}

if (process.argv.includes('--coord-password')) {
  askNewPassword().then((password) => { setCoordPassword(password); console.log('Senha do coordenador atualizada.'); process.exit(0); });
} else startServer();
