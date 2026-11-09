(() => {
  const features = {
    kpi: ['KPI и источники', 'План, факт, вес и вклад показателя в премию.'],
    monthClose: ['Готовность месяца', 'Смены, разрешения, авансы и начисления перед согласованием.'],
    queue: ['Очередь решений', 'Карточки проверок и заявок со ссылками на исходные решения.'],
    coverage: ['Покрытие смен', 'Замены на период отпуска и доступные сотрудники.'],
    bots: ['Боты и доставка', 'Получатели, расписание и журнал отправки.']
  };
  const status = {
    draft: ['Черновик', 'neutral'], ready: ['Готово', 'good'], posted: ['Начислено', 'good'],
    attention: ['Нужна проверка', 'warn'], excluded: ['Исключён', 'neutral'], voided: ['Отменено', 'neutral'],
    pending: ['Ожидает решения', 'warn'], open: ['Открыто', 'neutral'], reviewing: ['На проверке', 'warn'],
    blocked: ['Требует исправления', 'bad'], warning: ['Предупреждение', 'warn'],
    covered: ['Есть замена', 'good'], unassigned: ['Без замены', 'warn'], conflict: ['Конфликт', 'bad'],
    sent: ['Отправлено', 'good'], delivered: ['Доставлено', 'good'], sending: ['Отправляется', 'neutral'],
    failed: ['Ошибка', 'bad'], uncertain: ['Исход неизвестен', 'warn'], skipped: ['Пропущено', 'neutral'],
    stale: ['Данные устарели', 'warn'], missing: ['Нет данных', 'warn'], current: ['Обновлено', 'good'],
    active: ['Включено', 'good'], connected: ['Подключено', 'good'], provisional: ['Предварительно', 'neutral'],
    available: ['Есть данные', 'good'], manual: ['Вручную', 'neutral'], unavailable: ['Недоступно', 'warn'],
    disconnected: ['Не подключено', 'warn'], disabled: ['Выключено', 'neutral']
  };
  const destinations = new Set(['attendance', 'telegram', 'hr', 'hrcenter', 'storeops', 'payroll', 'network', 'finance', 'hr-insights']);
  const format = new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 2});
  const value = n => Number.isFinite(n) ? format.format(n) : '—';
  const percent = n => Number.isFinite(n) ? `${value(n)}%` : '—';
  const amount = (n, currency = 'UZS') => Number.isSafeInteger(n) ? `${value(n / 100)} ${esc(currency)}` : '—';
  const timeLabel = at => {
    const date = at ? new Date(at) : null;
    return date && Number.isFinite(+date) ? new Intl.DateTimeFormat('ru-RU', {dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Tashkent'}).format(date) : '—';
  };
  const checked = flag => flag ? ' checked' : '';
  const empty = text => `<p class="ac-empty">${esc(text)}</p>`;
  const badge = key => {
    const [label, type] = Object.hasOwn(status, key) ? status[key] : [key || 'Нет данных', 'neutral'];
    return `<span class="ac-badge ac-${type}">${esc(label)}</span>`;
  };
  const stack = (title, detail) => `<strong>${esc(title)}</strong>${detail ? `<small>${esc(detail)}</small>` : ''}`;
  const table = (headers, rows, message) => rows.length ? `<div class="table-wrap ac-table-wrap"><table class="data-table ac-table"><thead><tr>${headers.map(h => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : empty(message);
  const row = (...cells) => `<tr>${cells.map(cell => `<td>${cell}</td>`).join('')}</tr>`;
  function origin(href, label, item = {}) {
    const key = String(href || '').match(/^\/?#([a-z-]+)$/)?.[1];
    if (!destinations.has(key)) return '';
    return `<a class="ac-link" href="/#${key}" data-ac-go="${key}" data-ac-source="${esc(item.sourceId || item.leaveId || '')}" data-ac-kind="${esc(item.kind || '')}" data-ac-date="${esc(item.date || '')}">${esc(label)} <span aria-hidden="true">↗</span></a>`;
  }
  function figures(items) {
    return `<dl class="ac-figures">${items.map(([label, number]) => `<div><dt>${esc(label)}</dt><dd>${esc(number)}</dd></div>`).join('')}</dl>`;
  }
  function staffPicker(key, ids, employees, title = 'Ответственные') {
    const chosen = new Set(ids || []);
    return `<details class="ac-staff" data-ac-staff="${esc(key)}"><summary>${esc(title)} <span data-ac-count>${chosen.size || 'Не назначены'}</span></summary><fieldset><legend class="sr-only">${esc(title)}</legend>${employees.length ? employees.map(person => `<label><input type="checkbox" name="${esc(key)}-staff" value="${esc(person.id)}"${checked(chosen.has(person.id))}><span>${stack(person.name, person.role)}</span></label>`).join('') : empty('Нет активных сотрудников.')}</fieldset></details>`;
  }
  function featureSettings(key, setting, employees) {
    return `<div class="ac-feature" data-ac-feature="${key}"><label class="ac-switch"><input type="checkbox" name="${key}-enabled"${checked(setting?.enabled)}><span>Включить функцию</span></label>${staffPicker(key, setting?.responsibleIds, employees)}</div>`;
  }
  function kpiPanel(kpi) {
    const summary = kpi?.summary || {};
    const rows = (kpi?.rows || []).map(r => {
      const metricRows = (r.metrics || []).map(m => row(
        stack(m.label, [m.source, m.detail].filter(Boolean).join(' · ')),
        esc(m.plan == null ? '—' : `${value(m.plan)} ${m.unit || ''}`), esc(m.fact == null ? '—' : `${value(m.fact)} ${m.unit || ''}`),
        percent(m.weight), percent(m.percent), Number.isFinite(m.contribution) ? `${value(m.contribution)} п. п.` : '—', badge(m.status)
      ));
      const metrics = metricRows.length ? `<tr class="ac-metric-row"><td colspan="6"><details data-ac-employee="${esc(r.employeeId)}"><summary>Показатели · ${esc(r.name)} · ${metricRows.length}</summary>${table(['Показатель и источник', 'План', 'Факт', 'Вес', 'Выполнение', 'Вклад в KPI', 'Статус'], metricRows)}</details></td></tr>` : '';
      const money = stack(amount(r.amount, r.currency), r.maximum == null ? '' : `Максимум ${amount(r.maximum, r.currency)}`) + (r.redistributedAmount > 0 ? `<small>Перераспределено ${amount(r.redistributedAmount, r.currency)}</small>` : '');
      return row(stack(r.name, r.role), percent(r.percent), percent(r.teamPercent), percent(r.personalPercent), money, badge(r.status) + (r.detail ? `<small>${esc(r.detail)}</small>` : '') + origin(r.href, 'Источник')) + metrics;
    });
    const source = summary.sourceStatus ? `<p class="ac-source">Источник расчёта ${badge(summary.sourceStatus)}${summary.sourceAsOf ? ` · ${esc(timeLabel(summary.sourceAsOf))}` : ''}${summary.sourceDetail ? ` · ${esc(summary.sourceDetail)}` : ''}</p>` : '';
    return figures([['Сотрудники', summary.employees ?? 0], ['Готово', summary.ready ?? 0], ['Нужна проверка', summary.attention ?? 0], ['Начислено', summary.posted ?? 0]]) +
      (Number.isFinite(summary.teamWeight) ? `<p class="ac-note">Командный KPI <strong>${percent(summary.teamPercent)}</strong> · командный вес <strong>${percent(summary.teamWeight)}</strong> · личный вес <strong>${percent(summary.personalWeight)}</strong></p>` : '') + source +
      table(['Сотрудник и показатели', 'Итог', 'Команда', 'Личный', 'Премия', 'Статус'], rows, 'Расчёт KPI за этот месяц пока отсутствует.');
  }
  function readinessPanel(readiness) {
    const summary = readiness?.summary || {};
    const rows = (readiness?.rows || []).map(r => {
      const checks = (r.checks || []).map(c => `<li><strong>${esc(c.label)}</strong>${badge(c.status)}${c.detail ? `<small>${esc(c.detail)}</small>` : ''}</li>`).join('');
      const amounts = r.amounts ? `<small>Аванс ${amount(r.amounts.advance, r.amounts.currency)} · Выплачено ${amount(r.amounts.payout, r.amounts.currency)} · Остаток ${amount(r.amounts.remaining, r.amounts.currency)}</small>` : '';
      return row(stack(r.name, r.detail) + amounts, badge(r.status), checks ? `<details data-ac-readiness="${esc(r.employeeId)}"><summary>Проверки · ${r.checks.length}</summary><ul class="ac-checks">${checks}</ul></details>` : '—', origin(r.href, 'Открыть расчёт'));
    });
    const source = summary.sourceStatus ? `<p class="ac-source">МойСклад ${badge(summary.sourceStatus)}${summary.sourceAsOf ? ` · ${esc(timeLabel(summary.sourceAsOf))}` : ''}</p>` : '';
    return figures([['Сотрудники', summary.employees ?? 0], ['Готово', summary.ready ?? 0], ['Нужна проверка', summary.attention ?? 0], ['На согласовании', summary.pending ?? 0]]) +
      (summary.ended === false ? '<p class="ac-note">Месяц ещё идёт. Здесь показана предварительная сверка.</p>' : '') + source +
      table(['Сотрудник', 'Статус', 'Проверки', 'Расчёт'], rows, 'За этот месяц нет строк для сверки.');
  }
  function queuePanel(items, employees, focusId) {
    if (!items.length) return empty('Открытых задач за этот период нет.');
    const names = new Map(employees.map(person => [person.id, person.name]));
    return `<div class="ac-queue">${items.map(item => {
      const assignees = (item.responsibleIds || []).map(id => names.get(id)).filter(Boolean);
      return `<article class="ac-task${item.id === focusId ? ' ac-task-focused' : ''}" data-ac-task="${esc(item.id)}" tabindex="-1"><div>${badge(item.status)}${item.date ? `<span class="ac-task-date">${esc(item.date)}</span>` : ''}<h3>${esc(item.title)}</h3>${item.detail ? `<p>${esc(item.detail)}</p>` : ''}</div><div><small>${assignees.length ? `Ответственные · ${esc(assignees.join(', '))}` : 'Ответственный не назначен'}</small>${origin(item.href, 'Открыть решение', item)}</div></article>`;
    }).join('')}</div>`;
  }
  function coveragePanel(items) {
    return table(['Дата и отдел', 'Сотрудник', 'Покрытие', 'Варианты', 'Отпуск'], items.map(item => row(
      stack(item.date, item.department), esc(item.employeeName), badge(item.status) + (item.detail ? `<small>${esc(item.detail)}</small>` : ''),
      (item.substitutes?.length ? stack(item.substitutes.join(', '), 'Назначены') : '') + (item.candidates?.length ? `<small>Доступны · ${esc(item.candidates.map(c => c.name).join(', '))}</small>` : '') || '—',
      origin(item.href, item.kind === 'day-off' ? 'Открыть график' : 'Открыть отпуск', item)
    )), 'В выбранном месяце нет отпусков или выходных для проверки покрытия.');
  }
  function botCard(label, bot) {
    return `<article><h3>${esc(label)}</h3>${badge(bot?.connected ? 'connected' : 'disconnected')}${bot?.username ? `<p>${esc('@' + String(bot.username).replace(/^@/, ''))}</p>` : ''}${bot?.lastSeen ? `<p>Последняя связь · ${esc(timeLabel(bot.lastSeen))}</p>` : ''}${bot?.lastError ? `<p class="ac-issue">${esc(bot.lastError)}</p>` : ''}</article>`;
  }
  function botPanel(bots, options, settings, employees) {
    const integration = bots?.integration || {};
    const events = options.map(event => {
      const setting = settings?.[event.id] || {};
      const key = `event-${event.id}`;
      const channelNames = {group: 'Рабочая группа', private: 'Личный чат', service: 'Интеграция'};
      const channels = (event.channels || ['private']).map(channel => `<option value="${esc(channel)}"${setting.channel === channel ? ' selected' : ''}>${esc(channelNames[channel] || channel)}</option>`).join('');
      const botNames = {payroll: 'Зарплатный бот', salary: 'Зарплатный бот', integration: 'МойСклад'};
      const bot = botNames[event.bot] || 'Бот Davomat';
      const recipients = ['payrollPublished', 'salesSync'].includes(event.id) ? '' : staffPicker(key, setting.responsibleIds, employees, 'Получатели');
      return `<article class="ac-event" data-ac-event="${esc(event.id)}"><header><h3>${esc(event.label)}</h3><span class="ac-badge ac-neutral">${bot}</span></header><p>${esc(event.description || '')}</p><div class="ac-event-controls"><label class="ac-switch"><input type="checkbox" name="${esc(key)}-enabled"${checked(setting.enabled)}><span>${event.bot === 'integration' ? 'Запускать' : 'Отправлять'}</span></label><label>Канал<select name="${esc(key)}-channel">${channels}</select></label><label>Время · Ташкент<input type="time" name="${esc(key)}-time" value="${esc(setting.time || '')}" required></label></div>${recipients}</article>`;
    }).join('');
    const deliveries = table(['Событие', 'Получатель', 'Статус', 'Время', 'Действие'], (bots?.deliveries || []).map(item => row(
      esc(options.find(e => e.id === item.event)?.label || item.event), esc(item.recipient || '—'), badge(item.status) + (item.detail ? `<small>${esc(item.detail)}</small>` : ''), esc(timeLabel(item.updatedAt)),
      item.id && item.status === 'failed' ? `<button class="btn secondary" type="button" data-ac-retry="${esc(item.id)}">Повторить</button>` : '—'
    )), 'Отправок пока нет.');
    const health = bots ? `<div class="ac-bots">${botCard('Davomat', bots.attendance)}${botCard('Зарплатный бот', bots.payroll)}<article><h3>МойСклад</h3>${badge(integration.connected ? 'connected' : 'disconnected')}<p>Синхронизация · ${esc(timeLabel(integration.lastSync))}</p><p>Авансы · ${esc(timeLabel(integration.advanceSync))}</p>${[integration.lastError, integration.advanceError].filter(Boolean).map(e => `<p class="ac-issue">${esc(e)}</p>`).join('')}</article></div>` : empty('Рассылки центра приостановлены. Настройки событий можно подготовить заранее.');
    return `${health}<h3 class="ac-subhead">События и расписание</h3><p class="ac-note">Если для личного события не выбраны получатели, сообщение получат ответственные соответствующей функции.</p><div class="ac-events">${events || empty('Сценарии уведомлений недоступны.')}</div>${bots ? `<h3 class="ac-subhead">Журнал отправки</h3>${deliveries}` : ''}`;
  }

  let state;
  function draw(root) {
    const {view, month, page, error, focusId} = state;
    if (!view) {
      root.innerHTML = `<div class="ac-card"><p role="status">${esc(error || 'Загружаем данные центра…')}</p>${error ? '<button type="button" class="btn secondary" data-ac-refresh>Повторить</button>' : ''}</div>`;
      return;
    }
    const {settings, employees = [], eventOptions = []} = view;
    const panels = {
      kpi: () => kpiPanel(view.kpi), monthClose: () => readinessPanel(view.readiness),
      queue: () => queuePanel(view.queue || [], employees, focusId), coverage: () => coveragePanel(view.coverage || []),
      bots: () => botPanel(view.bots, eventOptions, settings.events, employees)
    };
    root.innerHTML = `<div class="ac-hero"><div><p class="ac-kicker">TAMEER HR · УПРАВЛЕНИЕ</p><h2>Настройки и результаты в одном месте</h2><p>Выберите функцию, назначьте ответственных и проверьте текущие задачи.</p></div><div class="ac-period"><label>Расчётный месяц<input type="month" name="automation-period" min="2000-01" max="2099-12" value="${esc(month)}" data-ac-month></label><button type="button" class="btn secondary" data-ac-refresh>Обновить</button></div></div>
    <div class="ac-tabs" role="tablist" aria-label="Функции центра">${Object.entries(features).map(([key, [title]]) => `<button type="button" role="tab" id="ac-tab-${key}" aria-selected="${page === key}" aria-controls="ac-panel-${key}" tabindex="${page === key ? '0' : '-1'}" data-ac-page="${key}">${title}</button>`).join('')}</div>
    <form class="ac-form" id="ac-settings"><div class="ac-actions"><p role="status" data-ac-status>${esc(error || '')}</p><div><button type="reset" class="btn secondary" data-ac-reset hidden>Отменить изменения</button><button type="submit" class="btn" data-ac-save>Сохранить настройки</button></div></div>${Object.entries(features).map(([key, [title, description]]) => {
      const setting = settings.features[key];
      return `<section class="ac-card" role="tabpanel" id="ac-panel-${key}" aria-labelledby="ac-tab-${key}"${page === key ? '' : ' hidden'}><header><div><h2>${title}</h2><p>${description}</p></div>${badge(setting?.enabled ? 'active' : 'disabled')}</header>${featureSettings(key, setting, employees)}${key === 'bots' || setting?.enabled ? panels[key]() : empty('Функция выключена. Для запуска включите её и сохраните настройки.')}</section>`;
    }).join('')}</form>`;
    const focused = [...root.querySelectorAll('[data-ac-task]')].find(card => card.dataset.acTask === focusId);
    if (focusId && !state.focusHandled) {
      state.focusHandled = true;
      if (focused) requestAnimationFrame(() => { if (focused.isConnected) focused.focus(); });
    }
  }
  function changePage(root, page, focus = false) {
    state.page = page;
    for (const button of root.querySelectorAll('[data-ac-page]')) {
      const active = button.dataset.acPage === page;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      root.querySelector('#ac-panel-' + button.dataset.acPage).hidden = !active;
      if (active && focus) button.focus();
    }
  }
  const field = (form, name) => form.elements.namedItem(name);
  const staff = (form, key) => [...form.querySelectorAll(`input[name="${CSS.escape(key)}-staff"]:checked`)].map(i => i.value);
  function hasDraft(root) {
    const form = root.querySelector('.ac-form');
    return !!form && (form.querySelector('[data-ac-save]').disabled || [...form.elements].some(input => {
      if (input.type === 'checkbox') return input.checked !== input.defaultChecked;
      if (input.type === 'time') return input.value !== input.defaultValue;
      if (input.tagName === 'SELECT') return input.selectedIndex !== Math.max(0, [...input.options].findIndex(option => option.defaultSelected));
      return false;
    }));
  }
  function readSettings(form) {
    const {settings, eventOptions = []} = state.view;
    return {
      version: settings.version,
      features: Object.fromEntries(Object.keys(features).map(key => [key, {enabled: field(form, key + '-enabled').checked, responsibleIds: staff(form, key)}])),
      events: Object.fromEntries(eventOptions.map(event => {
        const key = `event-${event.id}`;
        return [event.id, {enabled: field(form, key + '-enabled').checked, channel: field(form, key + '-channel').value, time: field(form, key + '-time').value, responsibleIds: staff(form, key)}];
      }))
    };
  }
  async function refresh(root, force = false) {
    const current = state;
    if (!force && current.view && Date.now() - current.loadedAt < 15000) return;
    const month = current.month;
    if (!force && current.request?.month === month) {
      if (current.request.root === root) return;
      current.request.root = root;
    } else {
      current.request = {root, month, promise: api('automation-center?month=' + encodeURIComponent(month))};
    }
    const request = current.request;
    try {
      const view = await request.promise;
      if (state !== current || current.month !== month || current.request !== request || request.root !== root || !root.isConnected) return;
      if (!force && current.view && !window.LiveRefresh?.ready(root)) return;
      current.view = view;
      current.error = '';
      current.loadedAt = Date.now();
    } catch (error) {
      if (state !== current || current.month !== month || current.request !== request || request.root !== root || !root.isConnected) return;
      if (!force && current.view) return;
      current.error = error.message;
    } finally {
      if (current.request === request && request.root === root) current.request = null;
    }
    const render = () => draw(root);
    if (!force && window.LiveRefresh) window.LiveRefresh.preserve(root, render);
    else render();
  }
  async function openOrigin(link) {
    const {acGo: key, acKind: kind, acDate: date, acSource: source} = link.dataset;
    const section = key === 'hr-insights' ? 'hrplus' : key;
    if (section === 'hr') hrSection = 'leaves';
    if (section === 'hrcenter') { hrWorkspacePage = kind === 'hr-request' ? 'day' : 'month'; hrWorkspaceMonth = state.month; }
    if (section === 'payroll') payMonth = state.month;
    if (section === 'finance') financeMonth = state.month;
    if (section === 'network') networkTab = 'approvals';
    if (section === 'storeops') {
      storeOpsTab = kind === 'day-off' ? 'schedule' : 'corrections';
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) storeOpsDay = date;
    }
    if (section === 'attendance' && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      selectedDay = date;
      tab = section;
      history.replaceState(null, '', '/#attendance');
      await load();
    } else {
      await workspaceNavigate(section);
    }
    if (source) {
      const selectors = ['data-id', 'data-shift-decision', 'data-late-decision', 'data-token', 'data-shift'];
      const target = app.querySelector(selectors.map(attr => `[${attr}="${CSS.escape(source)}"]`).join(','));
      target?.scrollIntoView({block: 'center'});
      target?.focus({preventScroll: true});
    }
  }
  function bind(root) {
    const showReset = () => {
      const reset = root.querySelector('[data-ac-reset]');
      if (reset) reset.hidden = !hasDraft(root);
    };
    root.addEventListener('input', showReset);
    root.addEventListener('reset', () => queueMicrotask(() => {
      root.querySelectorAll('[data-ac-staff]').forEach(picker => {
        picker.querySelector('[data-ac-count]').textContent = picker.querySelectorAll('input:checked').length || 'Не назначены';
      });
      const message = root.querySelector('[data-ac-status]');
      if (message) message.textContent = '';
      showReset();
    }));
    root.addEventListener('change', async event => {
      const input = event.target;
      const picker = input.closest('[data-ac-staff]');
      if (picker) picker.querySelector('[data-ac-count]').textContent = picker.querySelectorAll('input:checked').length || 'Не назначены';
      if (!input.matches('[data-ac-month]') || !input.value || !input.checkValidity() || input.value === state.month) return;
      if (hasDraft(root)) { input.value = state.month; toast('Сохраните изменения перед сменой месяца.'); return; }
      state.month = input.value;
      state.view = null;
      state.focusId = '';
      state.error = '';
      draw(root);
      await refresh(root, true);
    });
    root.addEventListener('click', async event => {
      const item = event.target.closest('[data-ac-page],[data-ac-refresh],[data-ac-retry],[data-ac-go]');
      if (!item) return;
      if (item.dataset.acPage) { changePage(root, item.dataset.acPage); return; }
      if (item.dataset.acGo) {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        if (hasDraft(root)) { toast('Сохраните изменения перед открытием решения.'); return; }
        try { await openOrigin(item); } catch (error) { toast(error.message); }
        return;
      }
      if (item.hasAttribute('data-ac-refresh')) {
        if (hasDraft(root)) {
          toast('Сохраните изменения настроек перед обновлением.');
          return;
        }
        await refresh(root, true);
        return;
      }
      item.disabled = true;
      try {
        await api('automation-center/deliveries/retry', {id: item.dataset.acRetry});
        toast('Отправка поставлена на повтор.');
        if (root.isConnected && window.LiveRefresh?.ready(root)) await refresh(root, true);
      } catch (error) { toast(error.message); }
      finally { item.disabled = false; }
    });
    root.addEventListener('keydown', event => {
      const key = event.target.dataset.acPage;
      if (!key || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const keys = Object.keys(features), index = keys.indexOf(key);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + keys.length) % keys.length;
      changePage(root, keys[next], true);
    });
    root.addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.target;
      const save = form.querySelector('[data-ac-save]');
      const message = form.querySelector('[data-ac-status]');
      save.disabled = true;
      try {
        await api('automation-center/settings', readSettings(form));
        if (root.isConnected) await refresh(root, true);
        toast('Настройки центра сохранены.');
      } catch (error) {
        message.textContent = error.message;
      } finally { save.disabled = false; }
    });
  }
  function mount(root) {
    if (!root || !data.user?.admin) return;
    if (!state || state.owner !== data.user.id) {
      const params = new URLSearchParams(location.search);
      const focusId = params.get('automationTask') || '';
      const requestedPage = params.get('automationPage');
      const paramMonth = params.get('month');
      const today = data.today;
      const month = /^20\d{2}-(0[1-9]|1[0-2])$/.test(paramMonth || '') ? paramMonth : today.slice(0, 7);
      const page = focusId ? 'queue' : Object.hasOwn(features, requestedPage) ? requestedPage : 'kpi';
      state = {owner: data.user.id, month, page, view: null, loadedAt: 0, focusId};
    }
    draw(root);
    bind(root);
    refresh(root);
  }
  window.AutomationCenterUI = {mount};
})();
