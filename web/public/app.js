'use strict';
const $ = id => document.getElementById(id);
const pretty = s => String(s).replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
const taskTypeLabel = type => type === 'exam_review' ? 'Quiz / exam review' : pretty(type);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let state;
let busy = false;
let noticeTimer;
let calendarMonth;
let calendarDate;
let refreshVersion = 0;
const minutesOf = value => { const [h,m] = value.split(':').map(Number); return h*60+m; };
const timeValue = minutes => `${String(Math.floor((minutes%1440)/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`;
const duration = minutes => minutes >= 60 ? `${Math.floor(minutes/60)}h${minutes%60 ? ` ${minutes%60}m` : ''}` : `${minutes}m`;

async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function showError(error) {
  const dialog = document.querySelector('dialog[open]');
  if (dialog) {
    const message = dialog.querySelector('.editor-error');
    message.textContent = error.message;
    message.hidden = false;
    return;
  }
  $('notice').hidden = true;
  $('error').textContent = error.message || 'Unable to connect. Check that the local server is running.';
  $('error').hidden = false;
  $('error').scrollIntoView({behavior:'smooth', block:'nearest'});
}

function notice(message) {
  $('error').hidden = true;
  $('notice').textContent = message;
  $('notice').hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 4500);
}

function deadline(days) {
  if (days < 0) return `${-days}d overdue`;
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  return `Due in ${days} days`;
}

function taskCard(task, completed = false) {
  return `<article class="task-card"><div class="task-top">
    <button class="task-check" data-action="${completed ? 'reopen' : 'complete'}" data-id="${esc(task.id)}" aria-label="${completed ? 'Reopen' : 'Complete'} ${esc(task.title)}">${completed ? '✓' : ''}</button>
    <div class="task-info"><h4 class="task-title">${esc(task.title)}</h4><div class="task-meta"><span>${esc(taskTypeLabel(task.type))} · ${esc(pretty(task.category))}</span><span>·</span><span>${duration(task.minutes)}</span><span>·</span><span>${esc(task.due_date)} · ${clock(task.deadline_time)}</span></div></div>
    <button class="delete" data-action="delete-task" data-id="${esc(task.id)}" aria-label="Delete ${esc(task.title)}">×</button></div>
    ${completed ? '' : `<div class="task-tags"><span class="tag ${task.days_left <= 2 ? 'due' : ''}">${esc(deadline(task.days_left))}</span></div>`}</article>`;
}

function render() {
  const pending = state.tasks.filter(task => task.status === 'pending');
  const completed = state.tasks.filter(task => task.status === 'completed');
  const date = new Date(`${state.today}T12:00:00+08:00`);
  $('today').textContent = date.toLocaleDateString('en-PH', {timeZone:'Asia/Manila', weekday:'long',month:'long',day:'numeric'}).toUpperCase();
  const groups = [
    ['do_first','Do First','','No tasks.'],
    ['do_next','Do Next','','No tasks.'],
    ['do_later','Do Later','','No tasks.']
  ];
  $('board').innerHTML = groups.map(([id,title,range,empty]) => {
    const tasks = pending.filter(task => task.bucket === id);
    return `<section class="bucket ${id}" aria-label="${title}"><div class="bucket-heading"><div class="bucket-title"><span class="dot" aria-hidden="true"></span><h3>${title}</h3><small>${range}</small></div><span class="count">${tasks.length}</span></div>${tasks.length ? tasks.map(task => taskCard(task)).join('') : `<p class="empty">${empty}</p>`}</section>`;
  }).join('');
  $('completed-label').textContent = `${completed.length} task${completed.length === 1 ? '' : 's'}`;
  $('completed').innerHTML = completed.length ? completed.map(task => taskCard(task,true)).join('') : '<p class="empty">No completed tasks.</p>';
  $('classes').innerHTML = state.classes.length ? state.classes.map(item => `<div class="class-row"><span class="class-day">${esc(item.day.slice(0,3))}</span><div class="class-info"><strong>${esc(item.subject)}</strong><span>${esc(pretty(item.day))} · ${clock(item.start)}–${clock(item.end)}</span></div><button class="edit-time" data-action="edit-class" data-id="${esc(item.id)}" aria-label="Edit ${esc(item.subject)} ${esc(item.day)} class">Edit</button><button class="delete" data-action="delete-class" data-id="${esc(item.id)}" aria-label="Delete ${esc(item.subject)} class">×</button></div>`).join('') : '<p class="empty">No classes.</p>';
  $('subject-options').innerHTML = [...new Set(state.classes.map(item => item.subject))].map(subject => `<option value="${esc(subject)}"></option>`).join('');
  $('planning-hours-label').textContent = `${clock(state.planning_settings.day_start)}–${clock(state.planning_settings.day_end)}`;
  if (!$('planning-form').dataset.dirty) {
    $('planning-start').value = timeValue(state.planning_settings.day_start);
    $('planning-end').value = timeValue(state.planning_settings.day_end);
  }
  const missing = state.plan.tasks.filter(task => task.unscheduled_minutes > 0);
  $('planning-warnings').hidden = !missing.length;
  $('planning-warnings').innerHTML = missing.map(task => `<p><strong>${esc(task.title)}</strong>: ${duration(task.unscheduled_minutes)} could not fit before ${esc(task.due_date)} at ${clock(task.deadline_time)} within the next 90 days. Adjust the deadline, time needed, classes, or planning hours.</p>`).join('');
  renderCalendar();
}

function renderCalendar() {
  const focusedDate = document.activeElement?.closest('#calendar-grid button')?.dataset.calendarDate;
  calendarDate ??= state.today;
  calendarMonth ??= calendarDate.slice(0,7);
  $('calendar-month').textContent = PlannerCalendar.format(`${calendarMonth}-01`, {month:'long',year:'numeric'});
  const tasksByDate = new Map();
  for (const task of state.tasks) {
    if (!tasksByDate.has(task.due_date)) tasksByDate.set(task.due_date, []);
    tasksByDate.get(task.due_date).push(task);
  }
  $('calendar-grid').innerHTML = PlannerCalendar.days(calendarMonth).map(iso => {
    const tasks = tasksByDate.get(iso) || [];
    const pending = tasks.filter(task => task.status === 'pending').length;
    const weekday = PlannerCalendar.format(iso,{weekday:'long'}).toLowerCase();
    const classCount = state.classes.filter(item => item.day === weekday).length;
    const sessions = state.plan.sessions.filter(session => session.date === iso).length;
    const classes = ['calendar-day', iso.slice(0,7) !== calendarMonth ? 'outside-month' : '',
      iso === state.today ? 'is-today' : '', iso === calendarDate ? 'is-selected' : ''].filter(Boolean).join(' ');
    const label = `${PlannerCalendar.format(iso,{weekday:'long',month:'long',day:'numeric',year:'numeric'})}, ${classCount} classes, ${sessions} planned work periods, ${pending} tasks due`;
    return `<button class="${classes}" type="button" data-calendar-date="${iso}" aria-label="${esc(label)}" aria-pressed="${iso === calendarDate}" ${iso === state.today ? 'aria-current="date"' : ''}><span>${Number(iso.slice(-2))}</span><span class="day-indicator ${pending ? 'pending' : 'done'}" aria-hidden="true">${pending || (tasks.length ? '✓' : '')}</span><span class="activity-dots" aria-hidden="true">${classCount ? '<i class="class-marker"></i>' : ''}${sessions ? '<i class="work-marker"></i>' : ''}</span></button>`;
  }).join('');
  const tasks = PlannerCalendar.tasksOn(state.tasks, calendarDate);
  const pending = tasks.filter(task => task.status === 'pending');
  const completed = tasks.filter(task => task.status === 'completed');
  $('calendar-day-caption').textContent = calendarDate === state.today ? 'TODAY' : 'SELECTED DAY';
  $('calendar-day-title').textContent = PlannerCalendar.format(calendarDate, {weekday:'long',month:'long',day:'numeric',year:'numeric'});
  const timeline = state.selected_date === calendarDate ? state.timeline : null;
  let content = timeline ? `<ol class="day-timeline">${timeline.events.map(timelineEvent).join('')}</ol>` : '<p class="empty">Loading…</p>';
  if (timeline && !timeline.events.length) content += '<p class="empty">No activities.</p>';
  if (pending.length) content += `<details class="due-details"><summary>Due on this date · ${pending.length}</summary>${pending.map(task => taskCard(task)).join('')}</details>`;
  if (completed.length) content += `<div class="calendar-completed"><p class="field-note">Completed · ${completed.length}</p>${completed.map(task => taskCard(task,true)).join('')}</div>`;
  if (!tasks.length) {
    const next = state.tasks.filter(task => task.status === 'pending' && task.due_date >= state.today).sort((a,b) => a.due_date.localeCompare(b.due_date))[0];
    if (next) content += `<button class="calendar-jump" type="button" data-calendar-date="${esc(next.due_date)}">Next deadline: ${esc(PlannerCalendar.format(next.due_date,{month:'short',day:'numeric',year:'numeric'}))} →</button>`;
  }
  $('calendar-tasks').innerHTML = content;
  if (focusedDate) document.querySelector(`#calendar-grid [data-calendar-date="${focusedDate}"]`)?.focus({preventScroll:true});
}

function timelineEvent(event) {
  const label = event.kind === 'class' ? 'Class' : event.kind === 'task' ? (event.manual_id ? 'Your chosen time' : 'Suggested work') : 'Free';
  const summary = event.kind === 'task' ? `${duration(event.minutes)}${event.subject ? ` · ${esc(event.subject)}` : ''}<br>Finish before ${esc(event.due_date)} · ${clock(event.deadline_time)}` : event.kind === 'class' ? 'Weekly class' : 'Available within your planning hours';
  const edit = event.kind === 'task' ? `<button class="edit-time" data-action="edit-work" data-id="${esc(event.task_id)}" data-date="${event.date}" data-start="${event.start}" data-end="${event.end}" data-manual="${esc(event.manual_id || '')}">Edit time</button>` : event.kind === 'class' ? `<button class="edit-time" data-action="edit-class" data-id="${esc(event.id)}">Edit class</button>` : '';
  return `<li class="timeline-item timeline-${event.kind}"><div class="timeline-time">${clock(event.start)}<br><span>to ${clock(event.end)}</span></div><div class="timeline-detail"><span class="timeline-kind">${label}</span><h4>${esc(event.title)}</h4><p>${summary}</p>${edit}</div></li>`;
}

async function selectCalendarDate(iso, focus = false) {
  calendarDate = iso;
  calendarMonth = iso.slice(0,7);
  renderCalendar();
  try {
    await refresh();
    if (focus && calendarDate === iso) document.querySelector(`#calendar-grid [data-calendar-date="${iso}"]`)?.focus({preventScroll:true});
  } catch (error) { showError(error); }
}

$('calendar-prev').addEventListener('click', () => {
  if (!state || busy) return;
  calendarMonth = PlannerCalendar.shiftMonth(calendarMonth,-1);
  selectCalendarDate(`${calendarMonth}-01`);
});
$('calendar-next').addEventListener('click', () => {
  if (!state || busy) return;
  calendarMonth = PlannerCalendar.shiftMonth(calendarMonth,1);
  selectCalendarDate(`${calendarMonth}-01`);
});
$('calendar-today').addEventListener('click', () => {
  if (state && !busy) selectCalendarDate(state.today);
});
$('calendar-title').closest('section').addEventListener('click', event => {
  const button = event.target.closest('button[data-calendar-date]');
  if (button && state && !busy) selectCalendarDate(button.dataset.calendarDate, true);
});

function clock(minutes) {
  const hour = Math.floor(minutes/60);
  return `${hour%12 || 12}:${String(minutes%60).padStart(2,'0')} ${hour < 12 || hour === 24 ? 'AM' : 'PM'}${hour === 24 ? ' (next day)' : ''}`;
}

function updateType() {
  const type = state.types.find(type => type.id === $('task-type').value);
  if (!type) return;
  $('duration-label').textContent = type.id === 'exam_review' ? 'Review time needed' : 'Total work time needed';
  $('task-minutes').value = $('task-unit').value === 'hours' ? Number((type.minutes/60).toFixed(2)) : type.minutes;
}

async function refresh() {
  const version = ++refreshVersion;
  const fresh = await api(`/api/state?minutes=${encodeURIComponent($('available').value)}${calendarDate ? `&date=${encodeURIComponent(calendarDate)}` : ''}`);
  if (version !== refreshVersion) return;
  state = fresh;
  render();
}

function updateDurationBounds() {
  const hours = $('task-unit').value === 'hours';
  $('task-minutes').min = hours ? '0.02' : '1';
  $('task-minutes').max = hours ? '168' : '10080';
  $('task-minutes').step = hours ? 'any' : '1';
}
$('task-unit').addEventListener('change', () => {
  const hours = $('task-unit').value === 'hours';
  $('task-minutes').value = hours ? Number(($('task-minutes').value/60).toFixed(2)) : Math.round($('task-minutes').value*60);
  updateDurationBounds();
});
$('planning-form').addEventListener('input', () => { $('planning-form').dataset.dirty = 'true'; });
$('planning-form').addEventListener('submit', event => {
  event.preventDefault();
  const start=minutesOf($('planning-start').value), end=minutesOf($('planning-end').value) || 1440;
  if (end <= start) { showError(new Error('Planning end must be after its start.')); return; }
  change('/api/planning',{day_start:start,day_end:end},'Planning hours saved. Suggestions recalculated.', () => { delete $('planning-form').dataset.dirty; });
});

async function change(path, body, message, onSaved = () => {}) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try {
    await api(path, body);
    onSaved();
    await refresh();
    notice(message);
  } catch (error) { showError(error); }
  finally {
    busy = false;
    document.querySelectorAll('button').forEach(button => { button.disabled = false; });
  }
}

$('task-type').addEventListener('change', updateType);
$('task-form').addEventListener('submit', event => {
  event.preventDefault();
  change('/api/tasks', {title:$('task-title').value, type:$('task-type').value,
    due_date:$('task-date').value, minutes:Math.round(Number($('task-minutes').value)*($('task-unit').value === 'hours' ? 60 : 1)),
    subject:$('task-subject').value,deadline_time:minutesOf($('task-deadline-time').value)},
    'Task saved. Your next steps are up to date.', () => { $('task-title').value = ''; $('task-title').focus(); });
});
$('class-form').addEventListener('submit', event => {
  event.preventDefault();
  const days = [...document.querySelectorAll('#class-days input:checked')].map(input => input.value);
  if (!days.length) {
    showError(new Error('Select at least one day for your class.'));
    document.querySelector('#class-days input').focus();
    return;
  }
  const minuteValue = value => { const [h,m] = value.split(':').map(Number); return h*60+m; };
  const start = minuteValue($('class-start').value), end = minuteValue($('class-end').value);
  if (end <= start) { showError(new Error('Class end must be after its start on the same day.')); return; }
  change('/api/classes', {subject:$('class-subject').value,days,start,end},
    `Class saved for ${days.length === 1 ? pretty(days[0]) : `${days.length} days`}.`,
    () => { $('class-subject').value = ''; });
});
$('time-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  try { await refresh(); $('error').hidden = true; } catch (error) { showError(error); }
});
document.addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  if (!button || busy) return;
  const {action,id} = button.dataset;
  if (action === 'edit-class') {
    const item = state.classes.find(item => item.id === id);
    if (!item) return;
    $('edit-class-id').value=id; $('edit-class-subject').value=item.subject;
    $('edit-class-day').value=item.day; $('edit-class-start').value=timeValue(item.start);
    $('edit-class-end').value=timeValue(item.end); openEditor('class-editor'); return;
  }
  if (action === 'edit-work') {
    const item=state.tasks.find(item => item.id === id);
    if (!item) return;
    $('edit-work-task').value=id; $('edit-work-id').value=button.dataset.manual;
    $('work-editor-task').textContent=item.title;
    $('edit-work-date').value=button.dataset.date;
    $('edit-work-date').min=state.today; $('edit-work-date').max=state.plan.end_date;
    $('edit-work-start').value=timeValue(Number(button.dataset.start));
    $('edit-work-end').value=timeValue(Number(button.dataset.end));
    $('work-auto').hidden=!button.dataset.manual; openEditor('work-editor'); return;
  }
  if (action === 'complete' || action === 'reopen') {
    change('/api/task_status', {id,status:action === 'complete' ? 'completed' : 'pending'},
      action === 'complete' ? 'One less thing on your plate. Task completed.' : 'Task reopened.');
  } else if (action === 'delete-task') {
    change('/api/delete_task', {id}, 'Task deleted.');
  } else if (action === 'delete-class') {
    change('/api/delete_class', {id}, 'Class deleted.');
  }
});

async function init() {
  await refresh();
  $('task-type').innerHTML = state.types.map(type => `<option value="${esc(type.id)}">${esc(taskTypeLabel(type.id))}</option>`).join('');
  $('task-type').value = 'assignment';
  $('task-type').disabled = false;
  $('task-date').value = state.today;
  document.querySelectorAll('button[type="submit"]').forEach(button => { button.disabled = false; });
  updateType();
}
function openEditor(id) {
  $(id).querySelector('.editor-error').hidden=true;
  $(id).showModal();
}
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
$('edit-class-form').addEventListener('submit', event => {
  event.preventDefault();
  change('/api/edit_class',{id:$('edit-class-id').value,subject:$('edit-class-subject').value,
    day:$('edit-class-day').value,start:minutesOf($('edit-class-start').value),end:minutesOf($('edit-class-end').value) || 1440},
    'Class updated. Your schedule has been recalculated.',() => $('class-editor').close());
});
$('edit-work-form').addEventListener('submit', event => {
  event.preventDefault();
  const date=$('edit-work-date').value;
  change('/api/session',{id:$('edit-work-id').value,task_id:$('edit-work-task').value,date,
    start:minutesOf($('edit-work-start').value),end:minutesOf($('edit-work-end').value) || 1440},
    'Work time saved. Remaining work has been rearranged.',() => {
      $('work-editor').close(); calendarDate=date; calendarMonth=date.slice(0,7);
    });
});
$('work-auto').addEventListener('click', () => change('/api/delete_session',{id:$('edit-work-id').value},
  'Work returned to automatic scheduling.',() => $('work-editor').close()));
init().catch(showError);
// Refresh date-relative rules when a tab resumes or stays open past midnight.
document.addEventListener('visibilitychange', () => { if (!document.hidden && state && !busy) refresh().catch(showError); });
setInterval(() => { if (!document.hidden && state && !busy) refresh().catch(showError); },60000);
