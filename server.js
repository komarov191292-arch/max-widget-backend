/**
 * Минимальный бэкенд для публичного виджета Max Messenger (amoMarket).
 *
 * Задачи:
 *   1) GET/POST /oauth        — callback ПУБЛИЧНОЙ интеграции (установка из amoMarket).
 *                               Обменивает code на токен установщика (handshake), чтобы
 *                               установка завершалась корректно. Токен сохраняется,
 *                               но для создания сделки НЕ требуется.
 *   2) POST    /api/install   — пинг от виджета (onSave): { phone, account_id, subdomain }.
 *                               Создаёт СДЕЛКУ в ВАШЕМ (вендорском) AmoCRM по API v4.
 *   3) GET     /oauth/vendor  — одноразовый bootstrap токена ВАШЕГО аккаунта
 *                               (из ПРИВАТНОЙ интеграции в вашем AmoCRM).
 *
 * Требуется Node.js >= 18 (глобальный fetch). Зависимости: express.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

// --- мини-загрузчик .env (без зависимостей) ---
try {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
        fs.readFileSync(envPath, 'utf8').split('\n').forEach(function (line) {
            const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
            if (m && !process.env[m[1]]) {
                process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
            }
        });
    }
} catch (e) { /* no-op */ }

// ===== Конфигурация (см. .env.example) =====
const PORT = process.env.PORT || 3000;

// ВАШ (вендорский) аккаунт — куда падают сделки об установках.
// Создаётся ПРИВАТНАЯ интеграция внутри вашего собственного AmoCRM.
const VENDOR_SUBDOMAIN     = process.env.VENDOR_SUBDOMAIN;
const VENDOR_CLIENT_ID     = process.env.VENDOR_CLIENT_ID;
const VENDOR_CLIENT_SECRET = process.env.VENDOR_CLIENT_SECRET;
const VENDOR_REDIRECT_URI  = process.env.VENDOR_REDIRECT_URI;

// ПУБЛИЧНАЯ интеграция (для amoMarket) — handshake при установке + проверка пинга.
const PUBLIC_CLIENT_ID     = process.env.PUBLIC_CLIENT_ID;
const PUBLIC_CLIENT_SECRET = process.env.PUBLIC_CLIENT_SECRET;
const PUBLIC_REDIRECT_URI  = process.env.PUBLIC_REDIRECT_URI;

const TOKENS_FILE    = path.join(__dirname, 'tokens.json');          // токены вендора
const INSTALLERS_FILE = path.join(__dirname, 'installer_tokens.json'); // токены установщиков
const SEEN_FILE      = path.join(__dirname, 'installs.json');        // дедуп сделок

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // self.crm_post шлёт form-urlencoded

// ===== CORS: разрешаем прямые вызовы из карточек amoCRM/Kommo =====
app.use(function (req, res, next) {
    const origin = req.headers.origin || '';
    if (/\.amocrm\.(ru|com)$/.test(origin) || /\.kommo\.com$/.test(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// ===== Простые JSON-хранилища (файлы) =====
function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { return fallback; }
}
function writeJson(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ===== Токен ВАШЕГО (вендорского) аккаунта с авто-refresh =====
async function getVendorAccessToken() {
    // Простой путь (рекомендуется): долгоживущий токен из приватной интеграции —
    // одна переменная окружения, без bootstrap и без файла tokens.json.
    if (process.env.VENDOR_LONG_LIVED_TOKEN) {
        return process.env.VENDOR_LONG_LIVED_TOKEN;
    }
    // Альтернатива: OAuth с авто-refresh (нужен bootstrap через /oauth/vendor).
    let t = readJson(TOKENS_FILE, null);
    if (!t || !t.refresh_token) {
        throw new Error('Нет токенов вендора. Задайте VENDOR_LONG_LIVED_TOKEN или выполните /oauth/vendor?code=…');
    }
    // ещё валиден (с запасом 60 c)?
    if (t.access_token && t.expires_at && Date.now() < t.expires_at - 60000) {
        return t.access_token;
    }
    // обновляем по refresh_token (refresh_token ротируется — сохраняем новый!)
    const resp = await fetch(`https://${VENDOR_SUBDOMAIN}.amocrm.ru/oauth2/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client_id: VENDOR_CLIENT_ID,
            client_secret: VENDOR_CLIENT_SECRET,
            grant_type: 'refresh_token',
            refresh_token: t.refresh_token,
            redirect_uri: VENDOR_REDIRECT_URI
        })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
        throw new Error('Не удалось обновить токен вендора: ' + resp.status + ' ' + JSON.stringify(data));
    }
    const saved = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + (data.expires_in || 0) * 1000
    };
    writeJson(TOKENS_FILE, saved);
    return saved.access_token;
}

// ===== Кастомные поля сделки: находим id по имени (с кэшем) =====
let _leadFieldsCache = null;
async function getLeadFieldsMap(token, base) {
    if (_leadFieldsCache) return _leadFieldsCache;
    const map = {};
    try {
        const r = await fetch(`${base}/api/v4/leads/custom_fields?limit=250`, {
            headers: { 'Authorization': 'Bearer ' + token }
        });
        const data = await r.json().catch(() => ({}));
        const fields = (data._embedded && data._embedded.custom_fields) || [];
        fields.forEach(function (f) {
            if (f && f.name) map[String(f.name).trim().toLowerCase()] = f.id;
        });
    } catch (e) { /* поля не найдены — не критично */ }
    _leadFieldsCache = map;
    return map;
}
function pickFieldId(map, names) {
    for (var i = 0; i < names.length; i++) {
        if (map[names[i].toLowerCase()]) return map[names[i].toLowerCase()];
    }
    return null;
}

// ===== Создание сделки в ВАШЕМ AmoCRM =====
async function createVendorLead(info) {
    const token = await getVendorAccessToken();
    const base = `https://${VENDOR_SUBDOMAIN}.amocrm.ru`;

    const acc = info.account_id || info.subdomain || '?';
    const title = `Установка виджета Max — аккаунт ${acc}`;

    // /api/v4/leads/complex создаёт сделку + контакт + телефон одним запросом.
    // field_code: "PHONE" — стандартное поле телефона у контакта.
    const contact = { name: `Установщик ${info.subdomain || info.account_id || ''}`.trim() };
    if (info.phone) {
        contact.custom_fields_values = [{
            field_code: 'PHONE',
            values: [{ value: info.phone, enum_code: 'WORK' }]
        }];
    }

    // Кастомные поля СДЕЛКИ: account_id и subdomain (если такие поля созданы в AmoCRM).
    // Бэкенд сам находит их по имени — создайте текстовые поля сделки
    // с именами "account_id" и "subdomain".
    const fieldsMap = await getLeadFieldsMap(token, base);
    const leadCF = [];
    const accIdFieldId = pickFieldId(fieldsMap, ['account_id', 'account id', 'id аккаунта']);
    if (accIdFieldId && info.account_id != null) {
        leadCF.push({ field_id: accIdFieldId, values: [{ value: String(info.account_id) }] });
    }
    const subFieldId = pickFieldId(fieldsMap, ['subdomain', 'поддомен']);
    if (subFieldId && info.subdomain) {
        leadCF.push({ field_id: subFieldId, values: [{ value: String(info.subdomain) }] });
    }

    const lead = { name: title, _embedded: { contacts: [contact] } };
    if (leadCF.length) lead.custom_fields_values = leadCF;
    const body = [lead];

    const resp = await fetch(`${base}/api/v4/leads/complex`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
        throw new Error('leads/complex failed: ' + resp.status + ' ' + JSON.stringify(data));
    }
    const leadId = Array.isArray(data) && data[0] && data[0].id;

    // Примечание с деталями установки (необязательно).
    if (leadId) {
        try {
            await fetch(`${base}/api/v4/leads/${leadId}/notes`, {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
                body: JSON.stringify([{
                    note_type: 'common',
                    params: {
                        text:
                            'Виджет Max установлен.\n' +
                            'account_id: ' + (info.account_id || '-') + '\n' +
                            'subdomain: ' + (info.subdomain || '-') + '\n' +
                            'phone: ' + (info.phone || '-') + '\n' +
                            'version: ' + (info.widget_version || '-')
                    }
                }])
            });
        } catch (e) { /* примечание необязательно */ }
    }

    return leadId;
}

// ===== Роуты =====

// health-check
app.get('/', function (req, res) {
    res.send('Max widget backend OK');
});

// (1) Пинг об установке от виджета → создаём сделку у вендора.
app.post('/api/install', async function (req, res) {
    try {
        const account_id = req.body.account_id || null;
        const subdomain  = req.body.subdomain || null;
        const phone      = req.body.phone || null;
        const client_id  = req.body.client_id || null;
        const widget_version = req.body.widget_version || null;

        // лёгкая валидация источника
        if (PUBLIC_CLIENT_ID && client_id && client_id !== PUBLIC_CLIENT_ID) {
            return res.status(403).json({ ok: false, error: 'bad client_id' });
        }
        if (!account_id && !subdomain) {
            return res.status(400).json({ ok: false, error: 'no account' });
        }

        // дедуп: одна сделка на аккаунт
        const seen = readJson(SEEN_FILE, {});
        const key = String(account_id || subdomain);
        if (seen[key]) {
            return res.json({ ok: true, deduped: true, lead_id: seen[key] });
        }

        const leadId = await createVendorLead({ account_id, subdomain, phone, widget_version });
        seen[key] = leadId || true;
        writeJson(SEEN_FILE, seen);

        res.json({ ok: true, lead_id: leadId });
    } catch (e) {
        console.error('[install] error:', e);
        res.status(500).json({ ok: false, error: String(e.message || e) });
    }
});

// (2) Callback ПУБЛИЧНОЙ интеграции при установке из amoMarket.
//     Завершаем handshake (обмен code на токен установщика). Для создания сделки
//     токен установщика не нужен, но обмен делает установку «зелёной».
app.all('/oauth', async function (req, res) {
    try {
        const code = req.query.code || req.body.code;
        const referer = req.query.referer || req.body.referer; // напр. installer.amocrm.ru
        if (code && referer && PUBLIC_CLIENT_ID && PUBLIC_CLIENT_SECRET) {
            const host = /^https?:\/\//.test(referer) ? referer : 'https://' + referer;
            const r = await fetch(host + '/oauth2/access_token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    client_id: PUBLIC_CLIENT_ID,
                    client_secret: PUBLIC_CLIENT_SECRET,
                    grant_type: 'authorization_code',
                    code: code,
                    redirect_uri: PUBLIC_REDIRECT_URI
                })
            });
            const data = await r.json().catch(() => ({}));
            if (r.ok) {
                const store = readJson(INSTALLERS_FILE, {});
                store[referer] = {
                    access_token: data.access_token,
                    refresh_token: data.refresh_token,
                    expires_at: Date.now() + (data.expires_in || 0) * 1000
                };
                writeJson(INSTALLERS_FILE, store);
            } else {
                console.warn('[oauth] installer token exchange failed:', r.status, data);
            }
        }
    } catch (e) {
        console.warn('[oauth] error:', e);
    }
    // всегда отвечаем успехом, чтобы установка завершилась
    res.status(200).send('Max Messenger установлен. Вернитесь в amoCRM.');
});

// (3) Одноразовый bootstrap токена ВАШЕГО аккаунта.
//     Возьмите authorization code в ПРИВАТНОЙ интеграции вашего AmoCRM
//     и откройте в браузере: https://ваш-бэкенд/oauth/vendor?code=ВАШ_КОД
app.get('/oauth/vendor', async function (req, res) {
    const code = req.query.code;
    if (!code) return res.status(400).send('Передайте ?code= из приватной интеграции вашего AmoCRM');
    try {
        const r = await fetch(`https://${VENDOR_SUBDOMAIN}.amocrm.ru/oauth2/access_token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: VENDOR_CLIENT_ID,
                client_secret: VENDOR_CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: VENDOR_REDIRECT_URI
            })
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) return res.status(500).json(data);
        writeJson(TOKENS_FILE, {
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            expires_at: Date.now() + (data.expires_in || 0) * 1000
        });
        res.send('OK: токены вендора сохранены. Можно закрыть вкладку.');
    } catch (e) {
        res.status(500).send(String(e));
    }
});

app.listen(PORT, function () {
    console.log('Max widget backend listening on :' + PORT);
});
