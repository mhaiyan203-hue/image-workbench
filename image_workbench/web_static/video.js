(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const uuid = () => crypto.randomUUID().replaceAll('-', '');
  const requestedWorkspace = new URL(location.href).searchParams.get('workspace_id');
  const state = { account: null, config: null, csrf: '', project: null, mainProjectId: null, subprojectId: null,
    mainProjects: [], videoProjects: [], treeSequence: 0, shotRequest: uuid(), referenceOrder: [], runRequests: new Map(),
    projectSignature: '', loading: false, draftRevision: 0, shotRevision: 0, projectReadSequence: 0 };
  const labels = { draft: '待生成', queued: '已排队', running: '生成中', generating: '生成中', completed: '已完成', failed: '生成失败', uncertain: '结果未知 · 需核对' };
  const modes = { T2V: '文生视频', I2V: '首帧生视频', FL2V: '首尾帧生视频', R2V: '参考素材' };
  const resolutions = ['720p', '1080p'];
  const ratioNames = { landscape: '横向', portrait: '竖向', square: '方形' };
  const active = new Set(['queued', 'running', 'generating', 'uncertain']);

  // Consumers receive detached values and scoped commands. No module can mutate
  // the controller's state through a view or a project-change event.
  function snapshot() {
    return Object.freeze(structuredClone({account: state.account, config: state.config, project: state.project,
      mainProjectId: state.mainProjectId, subprojectId: state.subprojectId,
      referenceOrder: state.referenceOrder, draftRevision: state.draftRevision, shotRevision: state.shotRevision}));
  }
  function captureContext() {
    return Object.freeze({id: state.project?.project_id ?? null, account: state.account?.account_id,
      workspace: state.account?.workspace_id, revision: state.draftRevision, shotRevision: state.shotRevision});
  }
  function isCurrent(context, id = context.id, checkDraft = false) {
    return !state.selectingProject && !state.switchingWorkspace && context.account === state.account?.account_id
      && context.workspace === state.account?.workspace_id && context.revision === state.draftRevision
      && id === (state.project?.project_id ?? null) && (!checkDraft || context.shotRevision === state.shotRevision);
  }
  function shotChanged() { state.shotRevision++; state.shotRequest = uuid(); }
  function setReferences(ids, {context = captureContext(), mode = $('videoMode').value} = {}) {
    if (!isCurrent(context, context.id, true)) return false;
    if ($('videoBackend').value === 'online-2.0' && (ids.length || mode !== 'T2V')) throw new Error('当前 SD2.0 通道暂不支持参考图，图片仍保留在项目素材库');
    const order = [...new Set(ids)];
    if (!state.project || order.some(id => !state.project.assets.some(asset => asset.asset_id === id))) throw new Error('参考图片不属于当前项目，请刷新后重新选择');
    if (!Object.hasOwn(modes, mode) || order.length > (mode === 'I2V' ? 1 : mode === 'FL2V' ? 2 : 9)) throw new Error('参考图片数量不符合当前模式');
    state.referenceOrder = order; $('videoMode').value = mode; shotChanged(); renderAssets(state.project);
    return true;
  }
  function addReferences(ids, purpose, context) {
    if (!isCurrent(context, context.id, true)) return false;
    const order = [...state.referenceOrder]; let mode = $('videoMode').value;
    if (purpose === 'first' || purpose === 'last') {
      const index = purpose === 'first' ? 0 : 1;
      if (ids.length !== 1 || (order[index] && order[index] !== ids[0])) throw new Error('首尾帧一次只能指定一张；已有图片不会覆盖，请先取消对应选择');
      if (index === 1 && !order[0]) throw new Error('请先选择首帧，再设置尾帧；图片已保存到项目素材库');
      if (order.includes(ids[0]) && order[index] !== ids[0]) throw new Error('同一张图片已用于另一帧，请选择其他素材');
      if (order.length > 2) throw new Error('当前已选多张参考图，请先减少选择再设置首尾帧');
      order[index] = ids[0]; mode = order.length === 2 || mode === 'FL2V' ? 'FL2V' : 'I2V';
    } else {
      for (const id of ids) if (!order.includes(id)) order.push(id);
      const max = mode === 'I2V' ? 1 : mode === 'FL2V' ? 2 : 9;
      if (order.length > max) throw new Error(`当前模式最多选择 ${max} 张图片；图片已保存，请减少选择后重试`);
      if (mode === 'T2V') mode = 'R2V';
    }
    return setReferences(order, {context, mode});
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function notice(text, error = false) {
    const node = $('videoNotice');
    node.hidden = !text;
    node.classList.toggle('is-error', error);
    node.textContent = text;
  }
  let projectDialogMode = 'new-main', projectDialogTarget = null, projectDialogRequest = '';
  function openProjectDialog(mode = 'new-main', target = null) {
    projectDialogMode = mode; projectDialogTarget = target; projectDialogRequest = uuid();
    const editing = mode.startsWith('edit-'), sub = mode.includes('sub');
    $('videoProjectDialogEyebrow').textContent = editing ? (sub ? '子项目设置' : '主项目设置') : (sub ? '新建子项目' : '新建主项目');
    $('videoProjectDialogTitle').textContent = editing ? `编辑${sub ? '子项目' : '主项目'}` : '为项目命名';
    $('videoProjectDialogSubmit').textContent = editing ? '保存修改' : `创建${sub ? '子项目' : '主项目'}`;
    $('videoProjectDialogName').value = editing && target ? target.name || '' : '';
    $('videoProjectDialogDescription').value = editing && target ? target.description || '' : '';
    $('videoProjectDialog').showModal();
    setTimeout(() => $('videoProjectDialogName').focus(), 20);
  }
  function closeProjectDialog() { $('videoProjectDialog').close(); }
  document.querySelectorAll('#videoProjectDialog .close-dialog').forEach(button => button.addEventListener('click', closeProjectDialog));
  $('videoProjectDialogForm').addEventListener('submit', event => {
    event.preventDefault();
    busy($('videoProjectDialogSubmit'), async () => {
      const mode = projectDialogMode, target = projectDialogTarget;
      const name = $('videoProjectDialogName').value.trim();
      const description = $('videoProjectDialogDescription').value.trim();
      if (!name) throw new Error('请填写项目名称');
      const body = {name, description};
      let payload;
      if (mode === 'edit-main') {
        payload = await api(`/api/main-projects/${encodeURIComponent(target.main_project_id || target.project_id)}`, {method: 'PATCH', body: JSON.stringify(body)});
      } else if (mode === 'edit-sub') {
        payload = await api(`/api/subprojects/${encodeURIComponent(target.subproject_id)}`, {method: 'PATCH', body: JSON.stringify(body)});
      } else if (mode === 'new-sub') {
        const mainId = target.main_project_id || target.project_id;
        payload = await api(`/api/main-projects/${encodeURIComponent(mainId)}/subprojects`, {method: 'POST', body: JSON.stringify({request_id: projectDialogRequest, ...body})});
      } else {
        payload = await api('/api/main-projects', {method: 'POST', body: JSON.stringify({request_id: projectDialogRequest, ...body})});
      }
      closeProjectDialog();
      if (mode === 'new-main') {
        const sub = (payload.subprojects || []).find(item => item.subproject_id);
        if (sub) await selectSubproject(sub.subproject_id, {preserveDraft: true});
        else await loadProjectTree();
      } else if (mode === 'new-sub') {
        await selectSubproject(payload.subproject_id, {preserveDraft: true});
      } else {
        await loadProjectTree();
      }
      notice(mode.startsWith('edit-') ? '项目信息已更新' : '项目已创建');
    });
  });
  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (state.csrf) headers.set('X-Workbench-CSRF', state.csrf);
    if (!headers.has('X-Workspace-ID') && (state.account?.workspace_id || /^[0-9a-f]{32}$/.test(requestedWorkspace || ''))) headers.set('X-Workspace-ID',state.account?.workspace_id || requestedWorkspace);
    if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
    const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) { location.assign('/login'); throw new Error('请重新登录'); }
    if (!response.ok) throw Object.assign(new Error(typeof payload.detail === 'string' ? payload.detail : '请求未完成，请稍后重试'), {status: response.status});
    return payload;
  }
  async function busy(button, action) {
    if (button.disabled) return;
    button.disabled = true;
    try { await action(); } catch (error) { notice(error.message, true); }
    finally { if (button.isConnected) button.disabled = button.dataset.planning === 'true'; }
  }
  function mediaURL(path) {
    if (typeof path !== 'string' || !/^\/api\/(video\/|artifacts\/|scripts\/tasks\/)/.test(path)) return '';
    const url = new URL(path, location.origin);
    if (url.origin !== location.origin) return '';
    url.searchParams.set('workspace_id', state.account.workspace_id);
    return url.pathname + url.search;
  }
  function balance() {
    const wallet = state.account.credits || {};
    $('videoAccountName').textContent = state.account.username;
    $('videoCredits').textContent = wallet.is_unlimited ? '无限积分' : `可用 ${wallet.remaining_credit ?? 0} 积分 · 冻结 ${wallet.frozen_credit ?? 0}`;
  }
  async function refreshAccount() { state.account = await api('/api/auth/me'); balance(); }
  function enabledResolutions() {
    const enabled = state.config?.enabled_resolutions;
    return resolutions.filter(value => (Array.isArray(enabled) ? enabled : ['720p']).includes(value));
  }
  function rateFor(resolution) {
    const rate = state.config?.rates?.[resolution];
    return Number.isInteger(rate) && rate > 0 ? rate : null;
  }
  function resolutionView() {
    const resolution = $('videoResolution').value;
    const rate = rateFor(resolution);
    $('videoFixedPrice').textContent = rate ? `${resolution} · ${rate} 积分 / 秒 · 平台预设价格${$('videoBackend').value === 'online-2.0' ? ' · 在线输出按所选尺寸缩放' : ''}` : '正在读取预设价格';
    for (const option of $('videoRatio').options) {
      const size = state.config?.resolutions?.[resolution]?.[option.value];
      option.textContent = `${ratioNames[option.value]}${size ? ` · ${size.width} × ${size.height}` : ''}`;
    }
    quote();
  }
  function quote() {
    const resolution = $('videoResolution').value;
    const rate = rateFor(resolution);
    const duration = Number($('videoDuration').value);
    $('videoQuote').textContent = rate ? `${resolution} · ${duration} 秒 × ${rate} 积分 / 秒 = ${duration * rate} 积分 · 生成时冻结` : `管理员设置 ${resolution} 每秒积分后，即可提交生成`;
  }
  function configView() {
    const c = state.config;
    const enabled = enabledResolutions();
    const h3Option = $('videoBackend').querySelector('option[value="h3"]');
    if (h3Option) {
      h3Option.disabled = c.local_h3_available === false;
      h3Option.hidden = c.local_h3_available === false;
      if (h3Option.disabled && $('videoBackend').value === 'h3') { $('videoBackend').value = 'online-2.0'; updateBackend(); }
    }
    const backend = $('videoBackend').value;
    const online = backend === 'h3' ? c.worker_online : c.workers_online?.[backend] && c.workers_online?.['online-planner'];
    $('videoWorkerStatus').textContent = `${backend === 'h3' ? 'H3' : 'SD2.0'} 执行器${online ? '在线' : '离线 · 新任务排队'}`;
    $('videoAdminLink').hidden = !state.account.is_admin;
    const previous = $('videoResolution').value;
    $('videoResolution').replaceChildren();
    for (const resolution of enabled) {
      const option = el('option', '', resolution);
      option.value = resolution;
      option.disabled = backend === 'online-2.0' && resolution !== '720p';
      $('videoResolution').append(option);
    }
    $('videoResolution').value = enabled.includes(previous) ? previous : enabled[0] || '';
    resolutionView();
  }
  async function loadProjectTree() {
    const sequence = ++state.treeSequence;
    const [mainPayload, videoPayload] = await Promise.all([api('/api/main-projects'), api('/api/video/projects')]);
    if (sequence !== state.treeSequence) return {mains: state.mainProjects, projects: state.videoProjects};
    state.mainProjects = (Array.isArray(mainPayload.main_projects) ? mainPayload.main_projects : [])
      .filter(main => main.status !== 'archived');
    state.videoProjects = Array.isArray(videoPayload.projects) ? videoPayload.projects : [];
    renderProjectTree();
    return {mains: state.mainProjects, projects: state.videoProjects};
  }
  function renderProjectTree() {
    const list = $('videoProjectList'); list.replaceChildren();
    if (!state.mainProjects.length) {
      list.append(el('p', 'field-hint', '还没有主项目，点击右上角 + 创建'));
    }
    for (const main of state.mainProjects) {
      const mainId = main.main_project_id || main.project_id;
      const expanded = mainId === state.mainProjectId;
      const group = el('div', `project-tree-group${expanded ? ' expanded' : ''}`);
      const row = el('div', 'project-tree-main');
      const expand = el('button', 'project-expand', expanded ? '⌄' : '›');
      expand.type = 'button'; expand.setAttribute('aria-label', '展开或折叠子项目');
      expand.setAttribute('aria-expanded', String(expanded));
      expand.addEventListener('click', () => {
        const open = group.classList.toggle('expanded');
        expand.textContent = open ? '⌄' : '›'; expand.setAttribute('aria-expanded', String(open));
      });
      const button = el('button', `project-item${expanded ? ' selected' : ''}`);
      button.type = 'button';
      const marker = el('span', 'project-symbol'); marker.setAttribute('aria-hidden', 'true');
      button.append(marker, el('span', 'project-name', main.name || '未命名主项目'));
      button.addEventListener('click', () => selectMainProject(mainId).catch(error => notice(error.message, true)));
      const options = el('button', 'project-options', '⋯');
      options.type = 'button'; options.setAttribute('aria-label', `管理项目 ${main.name || ''}`);
      options.addEventListener('click', () => openProjectDialog('edit-main', main));
      row.append(expand, button, options);
      const children = el('div', 'project-tree-children');
      for (const sub of (Array.isArray(main.subprojects) ? main.subprojects : [])) {
        const childRow = el('div', 'project-child-row');
        const child = el('button', `project-child${sub.subproject_id === state.subprojectId ? ' selected' : ''}`);
        child.type = 'button';
        const dot = el('span', 'project-child-dot'); dot.setAttribute('aria-hidden', 'true');
        child.append(dot, el('span', 'project-name', sub.name || '未命名子项目'),
          el('span', 'project-child-count', String(Number(sub.task_count) || 0)));
        child.addEventListener('click', () => selectSubproject(sub.subproject_id).catch(error => notice(error.message, true)));
        const edit = el('button', 'project-sub-options', '⋯');
        edit.type = 'button'; edit.setAttribute('aria-label', `管理子项目 ${sub.name || ''}`);
        edit.addEventListener('click', () => openProjectDialog('edit-sub', sub));
        childRow.append(child, edit); children.append(childRow);
      }
      const add = el('button', 'project-child project-child-add', '＋ 新建子项目');
      add.type = 'button';
      add.addEventListener('click', () => openProjectDialog('new-sub', main));
      children.append(add);
      group.append(row, children); list.append(group);
    }
    renderLegacyProjects();
  }
  function renderLegacyProjects() {
    const host = $('videoLegacyProjects'); host.replaceChildren();
    const legacy = state.videoProjects.filter(project => !project.pipeline?.subproject_id);
    if (!legacy.length) return;
    host.append(el('span', 'side-label video-legacy-title', '待归档视频项目'));
    for (const project of legacy) {
      const row = el('div', 'video-legacy-row');
      const button = el('button', `video-project-button${project.project_id === state.project?.project_id ? ' is-active' : ''}`, project.name);
      button.type = 'button';
      button.addEventListener('click', () => {
        if (hasUnsavedDraft() && !window.confirm('当前项目还有未保存的内容，切换后将清空。确定切换吗？')) return;
        selectProject(project.project_id).catch(error => notice(error.message, true));
      });
      row.append(button);
      if (state.subprojectId) {
        const bind = el('button', 'text-button video-legacy-bind', '归入当前子项目');
        bind.type = 'button';
        bind.addEventListener('click', () => bindLegacyProject(project.project_id).catch(error => notice(error.message, true)));
        row.append(bind);
      }
      host.append(row);
    }
  }
  function allSubprojects() {
    return state.mainProjects.flatMap(main => (main.subprojects || []).map(sub => ({...sub, main_project_id: main.main_project_id || main.project_id})));
  }
  function renderAssets(project) {
    state.referenceOrder = state.referenceOrder.filter(id => project.assets.some(asset => asset.asset_id === id));
    const selected = new Set(state.referenceOrder);
    $('videoAssetGrid').replaceChildren();
    $('videoReferenceChoices').replaceChildren();
    for (const [index, asset] of project.assets.entries()) {
      const figure = el('figure', 'video-asset');
      const image = el('img'); image.src = mediaURL(`/api/video/projects/${project.project_id}/assets/${asset.asset_id}/thumbnail`); image.decoding = 'async'; image.width = 160; image.height = 100; image.alt = asset.filename; image.loading = 'lazy';
      figure.append(image, el('figcaption', '', `${index + 1}. ${asset.filename}`));
      if (window.IWAssetTray) figure.append(window.IWAssetTray.imageActions(asset));
      $('videoAssetGrid').append(figure);
      if (!selected.has(asset.asset_id)) continue;
      const label = el('div', 'video-reference-choice');
      const input = el('input'); input.type = 'checkbox'; input.value = asset.asset_id; input.checked = true; input.hidden = true;
      input.addEventListener('change', () => {
        state.referenceOrder = state.referenceOrder.filter(id => id !== asset.asset_id);
        if (input.checked) state.referenceOrder.push(asset.asset_id);
        shotChanged();
        referenceLabels();
      });
      const thumb = image.cloneNode(); thumb.alt = '';
      const remove = el('button', 'text-button', '移除'); remove.type = 'button';
      remove.setAttribute('aria-label', `移除参考图 ${asset.filename}`);
      remove.addEventListener('click', event => { event.preventDefault(); state.referenceOrder = state.referenceOrder.filter(id => id !== asset.asset_id); shotChanged(); renderAssets(state.project); });
      label.append(input, thumb, el('span', '', asset.filename), el('b', 'video-reference-order', ''), remove);
      $('videoReferenceChoices').append(label);
    }
    if (!project.assets.length) $('videoAssetGrid').append(el('p', 'field-hint', '先添加角色、场景或首帧图片。'));
    updateMode();
  }
  function updateMode() {
    const mode = $('videoMode').value;
    $('videoReferenceHelp').textContent = mode === 'T2V' ? `文生视频不使用参考图。已选 ${state.referenceOrder.length} 张已保留但不会生效；请移除参考图后保存。` : mode === 'I2V' ? '选择 1 张图片作为首帧，视频从该画面开始。' : mode === 'FL2V' ? '选择 2 张图片：先添加首帧，再添加尾帧。移除后重新添加可调整顺序。' : '选择 1–9 张参考图；按添加顺序对应 Picture 1、Picture 2…移除后重新添加可调整顺序。';
    for (const input of $('videoReferenceChoices').querySelectorAll('input')) input.disabled = false;
    referenceLabels();
  }
  function updateBackend() {
    if (state.config?.local_h3_available === false) $('videoBackend').value = 'online-2.0';
    const online = $('videoBackend').value === 'online-2.0';
    if (online) {
      $('videoMode').dataset.previous = $('videoMode').value;
      $('videoMode').value = 'T2V';
      $('videoResolution').value = '720p';
      if (![5, 10, 15].includes(Number($('videoDuration').value))) $('videoDuration').value = '5';
    } else if ($('videoMode').dataset.previous) {
      $('videoMode').value = $('videoMode').dataset.previous;
      delete $('videoMode').dataset.previous;
    }
    $('videoMode').disabled = online;
    for (const option of $('videoResolution').options) option.disabled = online && option.value !== '720p';
    $('videoBackendHelp').textContent = online ? 'DeepSeek Flash 按 SD2.0 Skill 整理提示词，再生成视频；支持文生视频，时长 5、10 或 15 秒。参考图暂未开放。' : '本机 H3 支持参考图、首帧和首尾帧。';
    const isOnline = online ? state.config?.workers_online?.['online-2.0'] && state.config?.workers_online?.['online-planner'] : state.config?.worker_online;
    $('videoWorkerStatus').textContent = `${online ? 'SD2.0' : 'H3'} 执行器${isOnline ? '在线' : '离线 · 新任务排队'}`;
    updateMode(); resolutionView(); shotChanged();
  }
  function referenceLabels() {
    const mode = $('videoMode').value;
    for (const label of $('videoReferenceChoices').querySelectorAll('.video-reference-choice')) {
      const index = state.referenceOrder.indexOf(label.querySelector('input').value);
      label.querySelector('.video-reference-order').textContent = index < 0 ? '' : mode === 'T2V' ? '未生效' : mode === 'I2V' ? (index === 0 ? '首帧' : '多余参考图') : mode === 'FL2V' ? (['首帧', '尾帧'][index] || '多余参考图') : `Picture ${index + 1}`;
    }
  }
  async function generateShot(shot) {
    const context = captureContext();
    if (shot.project_id !== context.id) throw new Error('项目已改变，请重新选择镜头');
    if (shot.run_blocked_reason) throw new Error(shot.run_blocked_reason);
    if (active.has(shot.status) || shot.status === 'completed') { location.hash = 'pipelineVideos'; return; }
    const expected = shot.estimated_credit;
    if (!Number.isInteger(expected) || expected < 1) throw new Error('请刷新视频报价');
    const summary = `确认生成「${shot.name}」？\n模式：${shot.mode}（${modes[shot.mode]}）\n参考图：${(shot.reference_ids || []).length} 张${shot.mode === 'T2V' ? '，文生视频不使用图片' : ''}\n时长：${shot.duration} 秒\n分辨率：${shot.resolution} · ${shot.width} × ${shot.height}\n将冻结：${expected} 积分\n未被执行器领取前可取消；领取后不可在网页中止。`;
    if (!window.confirm(summary) || !isCurrent(context)) return;
    const job = shot.current_job, key = `${shot.shot_id}:${job?.job_id || 'first'}`;
    if (!state.runRequests.has(key)) state.runRequests.set(key, uuid());
    const body = {request_id:state.runRequests.get(key),confirm_generation:true,expected_credit:expected};
    if (job?.status === 'failed') body.retry_of = job.job_id;
    await api(`/api/video/projects/${context.id}/shots/${shot.shot_id}/run`, {method:'POST',body:JSON.stringify(body)});
    if (!isCurrent(context)) return;
    await refresh(context); location.hash = 'pipelineVideos'; notice(`镜头已排队，冻结 ${expected} 积分。视频执行器未领取前可取消。`);
  }
  async function inspectQueue() {
    const data = await api('/api/video/uncertain-jobs');
    const panel = $('videoRecoveryPanel'); panel.replaceChildren(el('h3','','视频执行器核对'));
    for (const job of data.jobs) {
      const row=el('div','panel'); row.append(el('pre','field-hint',JSON.stringify(job,null,2)));
      if (!job.has_output) {
        const evidence=el('textarea'); evidence.placeholder='填写核对依据：原执行器、任务回执、停止时间及无结果证据'; evidence.setAttribute('aria-label','停止核对依据');
        const button=el('button','secondary-button','确认原任务已停止且无结果 · 释放冻结');button.type='button';
        button.addEventListener('click',()=>busy(button,async()=>{
          if (!evidence.value.trim()) throw new Error('请先填写执行器核对依据');
          if (!window.confirm('仅在已核对原执行停止且无可交付结果时确认。此操作不会终止执行器，也不会重新生成。')) return;
          await api(`/api/video/jobs/${job.job_id}/confirm-stopped`,{method:'POST',body:JSON.stringify({confirmed:true,evidence:evidence.value.trim()})});
          await inspectQueue(); await refresh();
        }));row.append(evidence,button);
      } else row.append(el('p','','已有输出，请先核对归档，不可直接释放冻结。'));
      panel.append(row);
    }
    if (!data.jobs.length) panel.append(el('p','','当前无结果未知的视频任务。'));
  }
  function renderShots(project) {
    const existingVideos = new Map(Array.from($('videoShots').querySelectorAll('video'), video => [video.dataset.jobId, video]));
    $('videoShots').replaceChildren();
    $('videoShotCount').textContent = `${project.shots.length} 个分镜`;
    for (const [index, shot] of project.shots.entries()) {
      const job = shot.current_job;
      const status = shot.status || job?.status || 'draft';
      const card = el('article', 'video-shot-card');
      const copy = el('div', 'video-shot-copy');
      const heading = el('div', 'video-shot-heading');
      heading.append(el('h3', '', `${String(index + 1).padStart(2, '0')}  ${shot.name}`), el('span', `status-pill video-status-${status}`, labels[status] || status));
      const resolution = resolutions.includes(shot.resolution) ? shot.resolution : null;
      const requiresRebuild = shot.requires_rebuild === true || !resolution;
      const blockedReason = shot.run_blocked_reason || (resolution && !enabledResolutions().includes(resolution) ? `${resolution} 暂未开放，请新建 720p 分镜。` : '');
      const rate = rateFor(resolution);
      const expected = requiresRebuild ? null : shot.estimated_credit ?? (rate ? shot.duration * rate : null);
      const cost = job?.credit_cost ?? expected;
      const size = Number.isInteger(shot.width) && Number.isInteger(shot.height) ? ` · ${shot.width} × ${shot.height}` : '';
      const displayMode = shot.mode === 'I2V' && shot.reference_ids?.length === 2 ? 'FL2V' : shot.mode;
      const meta = shot.source === 'upload' ? '用户上传 · MP4 · 0 积分' : `${shot.backend === 'online-2.0' ? 'SD2.0 · ' : 'H3 · '}${modes[displayMode] || displayMode} · ${resolution || '旧版分镜'}${size} · ${shot.duration} 秒 · ${(shot.reference_ids || []).length} 张参考图${cost != null ? ` · ${cost} 积分` : resolution ? ' · 待设置价格' : ''}`;
      copy.append(heading, el('p', 'video-shot-meta', meta), el('p', 'video-shot-prompt', shot.prompt));
      if (status === 'failed' || status === 'uncertain') copy.append(el('p', 'field-hint', status === 'uncertain' ? `结果未知，仍冻结 ${cost ?? '待核对'} 积分，并占用视频执行名额。无需再次点击生成；管理员需核对原执行器及结果，确认无结果且已停止后释放。任务编号：${job?.job_id || ''}` : `本次未完成，冻结积分已退回。${requiresRebuild || blockedReason ? '' : '可检查素材后重新提交。'}`));
      const actions = el('div', 'video-shot-actions');
      if (status === 'draft' || status === 'failed') {
        if (requiresRebuild || blockedReason) {
          actions.append(el('p', 'field-hint', blockedReason || `此分镜使用旧版尺寸。请在上方按原内容重新创建 ${enabledResolutions().join(' 或 ')} 高清分镜。`));
        } else {
          const canGenerate = rate !== null && expected !== null;
          const button = el('button', 'primary-button', canGenerate ? `${status === 'failed' ? '重新生成' : '生成视频'} · ${expected} 积分` : `等待设置 ${resolution} 价格`);
          button.type = 'button'; button.disabled = !canGenerate;
          button.addEventListener('click', () => busy(button, async () => {
            const context = captureContext(); if (context.id !== project.project_id || !isCurrent(context)) return;
            await generateShot(shot);
          }));
          actions.append(button);
        }
      }
      if (shot.download_url) {
        const link = el('a', 'secondary-button', '下载 MP4'); link.href = mediaURL(shot.download_url); actions.append(link);
      }
      if (status === 'queued') {
        const cancel = el('button', 'secondary-button', '取消排队 · 释放冻结积分'); cancel.type = 'button';
        cancel.addEventListener('click', () => busy(cancel, async () => {
          const context = captureContext();
          await api(`/api/video/projects/${project.project_id}/shots/${shot.shot_id}/cancel`, {method:'POST',body:JSON.stringify({job_id:job.job_id})});
          if (isCurrent(context)) { await refresh(context); notice('已取消未领取任务，冻结积分已释放。'); }
        })); actions.append(cancel);
      }
      if (status === 'running' || status === 'generating') actions.append(el('p','field-hint','执行器已领取，网页不能中止；请等待结果。异常时查看执行状态，不要重复提交。'));
      if (active.has(status)) { const inspect=el('button','text-button','查看执行状态与恢复指引');inspect.type='button';inspect.addEventListener('click',()=>busy(inspect,async()=>{const r=await api(`/api/video/projects/${project.project_id}/shots/${shot.shot_id}/recovery`);const detail=el('p','field-hint',`任务：${r.job_id || '尚未提交'} · ${labels[r.status] || r.status}。${r.failure?.message || ''}${r.evidence?.has_output ? '已收到输出，等待执行器校验归档。' : r.status === 'uncertain' ? '请将任务编号交给管理员；管理员可在本页顶部的核对入口查看原执行记录，确认停止且无结果后释放冻结。' : r.status === 'queued' ? '仍在排队，可以尝试取消；状态以服务器核验为准。' : '执行器处理期间不能在网页中止，请等待结果。'}`);actions.querySelector('[data-recovery-detail]')?.remove();detail.dataset.recoveryDetail='true';actions.append(detail);}));actions.append(inspect); }
      if (shot.output_url && window.IWAssetTray) actions.append(window.IWAssetTray.videoActions({artifact_id:shot.artifact_id || shot.output?.artifact_id,media_type:'video',shot_id:shot.shot_id,filename:shot.name,url:mediaURL(shot.output_url),download_url:mediaURL(shot.download_url)}));
      if (shot.bound_clip) { const preview=el('button','text-button','预览绑定视频'); preview.type='button'; preview.addEventListener('click',()=>window.IWAssetActions.preview({...shot.bound_clip,media_type:'video',filename:shot.name})); actions.append(preview); }
      copy.append(actions);
      const output = el('div', 'video-shot-output');
      if (shot.output_url) {
        const key = job?.job_id || shot.shot_id;
        let video = existingVideos.get(key);
        if (!video) { video = el('video'); video.controls = true; video.preload = 'metadata'; video.src = mediaURL(shot.output_url); video.dataset.jobId = key; video.setAttribute('playsinline', ''); video.setAttribute('aria-label', `${shot.name} 生成视频`); }
        output.append(video);
      } else output.append(el('span', '', status === 'draft' ? '视频将在这里呈现' : status === 'queued' ? '已进入生成队列' : status === 'failed' ? '本次没有可交付视频' : status === 'uncertain' ? '等待核对原任务结果' : '正在生成这一镜'));
      card.append(copy, output); $('videoShots').append(card);
    }
    if (!project.shots.length) $('videoShots').append(el('div', 'video-empty', '还没有分镜。填写上方镜头内容并保存，再单独点击生成。'));
  }
  function projectView(project, force = false, preserveDraft = false, notify = true) {
    state.project = structuredClone(project);
    state.mainProjectId = project.main_project_id || null;
    state.subprojectId = project.subproject_id || null;
    $('videoProjectDetail').hidden = false;
    $('videoProjectIntro').hidden = false;
    $('videoActiveName').textContent = project.name; $('videoProjectCrumb').textContent = project.name;
    $('videoActiveScript').textContent = project.script || '未填写脚本说明';
    const signature = JSON.stringify([project.assets, project.shots, state.config.rates, enabledResolutions()]);
    if (force || signature !== state.projectSignature) { renderAssets(project); renderShots(project); state.projectSignature = signature; }
    if (notify) document.dispatchEvent(new CustomEvent('video-project-view', { detail: { project: structuredClone(project), force, preserveDraft, context: captureContext() } }));
  }
  function rememberSelection() {
    if (state.mainProjectId) localStorage.setItem('image-workbench.project', state.mainProjectId);
    if (state.subprojectId) localStorage.setItem('image-workbench.subproject', state.subprojectId);
  }
  function hasUnsavedDraft() {
    if (!state.project) return false;
    return Boolean($('videoShotName').value.trim() || $('videoShotPrompt').value.trim() || state.referenceOrder.length
      || $('pipelineScriptRequest').value.trim() || $('pipelineImagePrompt').value.trim());
  }
  async function selectProject(id, preserveDraft = false) {
    if (!preserveDraft) state.draftRevision++;
    const selection = {id, workspace: state.account?.workspace_id, revision: state.draftRevision};
    state.selectingProject = selection; state.projectReadSequence++;
    try {
      const project = await api(`/api/video/projects/${id}`);
      if (state.selectingProject !== selection || state.switchingWorkspace || selection.workspace !== state.account?.workspace_id) return null;
      state.selectingProject = null;
      if (!preserveDraft) { $('videoShotForm').reset(); updateBackend(); }
      state.referenceOrder = []; $('videoReferenceChoices').replaceChildren();
      projectView(project, true, preserveDraft); resolutionView();
      const url = new URL(location.href); url.searchParams.set('project', id);
      if (project.subproject_id) url.searchParams.set('subproject', project.subproject_id); else url.searchParams.delete('subproject');
      history.replaceState(null, '', url);
      rememberSelection();
      await loadProjectTree();
      return project;
    } finally { if (state.selectingProject === selection) state.selectingProject = null; }
  }
  async function selectSubproject(subprojectId, {preserveDraft = false} = {}) {
    if (state.selectingProject || state.switchingWorkspace) throw new Error('项目正在切换，请稍候再试');
    if (!preserveDraft && hasUnsavedDraft() && !window.confirm('当前项目还有未保存的内容，切换后将清空。确定切换吗？')) return null;
    if (!preserveDraft) state.draftRevision++;
    const selection = {id: null, subprojectId, workspace: state.account?.workspace_id, revision: state.draftRevision};
    state.selectingProject = selection; state.projectReadSequence++;
    try {
      const project = await api('/api/video/projects/from-subproject', {method: 'POST', body: JSON.stringify({subproject_id: subprojectId})});
      if (state.selectingProject !== selection || state.switchingWorkspace || selection.workspace !== state.account?.workspace_id) return null;
      state.selectingProject = null;
      if (!preserveDraft) { $('videoShotForm').reset(); updateBackend(); shotChanged(); }
      state.referenceOrder = []; $('videoReferenceChoices').replaceChildren();
      projectView(project, true, preserveDraft); resolutionView();
      const url = new URL(location.href);
      url.searchParams.set('project', project.project_id); url.searchParams.set('subproject', subprojectId);
      history.replaceState(null, '', url);
      rememberSelection();
      await loadProjectTree();
      return project;
    } finally { if (state.selectingProject === selection) state.selectingProject = null; }
  }
  async function selectMainProject(mainId) {
    const main = state.mainProjects.find(item => (item.main_project_id || item.project_id) === mainId);
    if (!main) throw new Error('主项目不存在或已归档');
    const subs = Array.isArray(main.subprojects) ? main.subprojects : [];
    const sub = subs.find(item => item.subproject_id === state.subprojectId) || subs[0];
    if (!sub) {
      openProjectDialog('new-sub', main);
      notice('这个主项目还没有子项目，请先创建一个');
      return null;
    }
    return selectSubproject(sub.subproject_id);
  }
  async function bindLegacyProject(projectId) {
    if (!state.subprojectId) throw new Error('请先选择要归入的子项目');
    await api(`/api/video/projects/${projectId}/bind-subproject`, {method: 'POST', body: JSON.stringify({subproject_id: state.subprojectId})});
    const project = await selectSubproject(state.subprojectId, {preserveDraft: true});
    notice('视频项目已归入当前子项目');
    return project;
  }
  async function ensureProject() {
    if (state.selectingProject || state.switchingWorkspace) throw new Error('项目正在切换，请稍候再试');
    if (state.project) return structuredClone(state.project);
    if (!state.account) throw new Error('工作台正在加载，请稍候再试');
    if (state.projectCreating && isCurrent(state.projectCreating.context)) return state.projectCreating.promise;
    const context = captureContext();
    state.projectDraft ||= { request_id: state.projectRequest, name: $('videoProjectName').value.trim() || `新作品 ${new Date().toLocaleString('zh-CN', { hour12: false })}`, script: '' };
    const pending = (async () => {
      const project = await api('/api/video/projects', { method: 'POST', body: JSON.stringify(state.projectDraft) });
      if (!isCurrent(context)) throw new Error('已切换项目，请在当前项目重新操作');
      await selectProject(project.project_id, true);
      if (!isCurrent(context, project.project_id)) throw new Error('已切换项目，请在当前项目重新操作');
      state.projectRequest = uuid(); state.projectDraft = null;
      return project;
    })();
    const creating = {context, promise: pending}; state.projectCreating = creating;
    try { return await pending; } finally { if (state.projectCreating === creating) state.projectCreating = null; }
  }
  async function refreshProject(context = captureContext(), {notify = true} = {}) {
    if (!context.id || !isCurrent(context)) return null;
    const sequence = ++state.projectReadSequence;
    let project;
    try { project = await api(`/api/video/projects/${context.id}`, {headers: {'X-Workspace-ID': context.workspace}}); }
    catch (error) {
      if (!isCurrent(context) || sequence !== state.projectReadSequence) return null;
      if (error.status !== 404) throw error;
      clearProject(true);
      const cleared = captureContext();
      await loadProjectTree();
      if (isCurrent(cleared)) notice('当前项目已删除或移出此工作空间。可在图片工作台回收站恢复项目，或直接上传图片开始新作品。', true);
      return null;
    }
    if (!isCurrent(context) || sequence !== state.projectReadSequence) return null;
    projectView(project, false, false, notify);
    return structuredClone(project);
  }
  async function refresh(context = captureContext()) {
    if (!isCurrent(context) || (state.loading && isCurrent(state.loading))) return;
    state.loading = context;
    try {
      const [config, account] = await Promise.all([api('/api/video/config'), api('/api/auth/me')]);
      if (!isCurrent(context)) return;
      state.config = config; state.account = account; configView(); balance();
      await refreshProject(context);
    } finally { if (state.loading === context) state.loading = false; }
  }

  function clearProject(preserveDraft = false) {
    state.draftRevision = (state.draftRevision || 0) + 1; state.selectingProject = null; state.project = null; state.projectSignature = '';
    state.projectRequest = uuid(); state.projectDraft = null; state.referenceOrder = []; shotChanged();
    if (!preserveDraft) { $('videoShotForm').reset(); updateBackend(); }
    $('videoProjectName').value = ''; $('videoActiveScript').textContent = ''; $('videoUploadMessage').textContent = '';
    renderAssets({ assets: [] }); renderShots({ shots: [] });
    document.dispatchEvent(new CustomEvent('video-project-cleared', {detail: {preserveDraft}})); $('videoCreatePanel').hidden = false; $('videoProjectIntro').hidden = true;
    $('videoProjectCrumb').textContent = '新作品'; notice('');
    const url = new URL(location.href); url.searchParams.delete('project'); history.replaceState(null, '', url);
  }
  $('newVideoProject').addEventListener('click', () => openProjectDialog('new-main'));
  $('videoShotForm').addEventListener('submit', event => {
    event.preventDefault();
    busy(event.submitter, async () => {
      const id = (await ensureProject()).project_id;
      const context = captureContext();
      const mode = $('videoMode').value;
      if (mode === 'T2V' && state.referenceOrder.length) throw new Error('已选参考图在文生视频中不会生效，请移除参考图或选择支持参考图的工作流');
      const refs = [...state.referenceOrder];
      if ($('videoBackend').value === 'online-2.0' && ![5, 10, 15].includes(Number($('videoDuration').value))) throw new Error('SD2.0 的时长请选择 5、10 或 15 秒');
      if (mode === 'I2V' && refs.length !== 1) throw new Error('首帧模式需要选择 1 张参考图');
      if (mode === 'FL2V' && refs.length !== 2) throw new Error('首尾帧模式需要选择 2 张参考图，依次为首帧和尾帧');
      if (mode === 'R2V' && (refs.length < 1 || refs.length > 9)) throw new Error('参考素材模式需要选择 1–9 张参考图');
      await api(`/api/video/projects/${id}/shots`, { method: 'POST', body: JSON.stringify({ request_id: state.shotRequest, name: $('videoShotName').value.trim(), prompt: $('videoShotPrompt').value.trim(), mode: mode === 'FL2V' ? 'I2V' : mode, duration: Number($('videoDuration').value), resolution: $('videoResolution').value, aspect_ratio: $('videoRatio').value, reference_ids: refs, backend: $('videoBackend').value }) });
      if (!isCurrent(context)) return;
      if (isCurrent(context, id, true)) { shotChanged(); $('videoShotName').value = ''; $('videoShotPrompt').value = ''; }
      await refresh(context); notice('分镜已保存。检查内容和积分后，点击对应镜头的“生成视频”。');
    });
  });
  $('videoMode').addEventListener('change', updateMode);
  $('videoBackend').addEventListener('change', updateBackend);
  $('videoShotForm').addEventListener('input', shotChanged);
  $('videoShotForm').addEventListener('change', shotChanged);
  $('videoResolution').addEventListener('change', resolutionView);
  $('videoDuration').addEventListener('input', quote);
  $('videoRefresh').addEventListener('click', event => busy(event.currentTarget, async () => { const context = captureContext(); await refresh(); await loadProjectTree(); if (isCurrent(context)) notice('状态已刷新'); }));
  $('videoWorkspace').addEventListener('change', async event => {
    if (hasUnsavedDraft() && !window.confirm('当前项目还有未保存的内容，切换工作空间后将清空。确定切换吗？')) {
      event.target.value = state.account.workspace_id; return;
    }
    state.draftRevision++; state.switchingWorkspace = true;
    try { await api('/api/workspaces/select', { method: 'POST', body: JSON.stringify({ workspace_id: event.target.value }) }); location.assign('/video'); }
    catch (error) { state.switchingWorkspace = false; event.target.value = state.account.workspace_id; notice(error.message, true); }
  });
  $('videoLogout').addEventListener('click', event => busy(event.currentTarget, async () => { await api('/api/auth/logout', { method: 'POST' }); location.assign('/login'); }));

  window.IWVideo = Object.freeze({ generateShot, snapshot, captureContext, isCurrent, setReferences, addReferences, refreshProject,
    api, refresh, notice, busy, mediaURL, el, uuid, ensureProject, selectProject, selectSubproject, selectMainProject,
    loadProjectTree, openProjectDialog });
  (async () => {
    const initialRevision = state.draftRevision;
    state.csrf = (await api('/api/config')).csrf_token;
    await refreshAccount();
    for (const workspace of state.account.workspaces) { const option = el('option', '', workspace.name); option.value = workspace.workspace_id; option.selected = workspace.workspace_id === state.account.workspace_id; $('videoWorkspace').append(option); }
    state.config = await api('/api/video/config'); configView(); updateBackend();
    await loadProjectTree();
    const params = new URL(location.href).searchParams;
    const requestedProject = params.get('project'), requestedSub = params.get('subproject');
    if (initialRevision === state.draftRevision && !state.project && !state.selectingProject && !state.switchingWorkspace) {
      const subs = allSubprojects(), subIds = new Set(subs.map(sub => sub.subproject_id));
      const projects = state.videoProjects.map(project => project.project_id);
      if (requestedProject && projects.includes(requestedProject)) await selectProject(requestedProject, true);
      else if (requestedSub && subIds.has(requestedSub)) await selectSubproject(requestedSub, {preserveDraft: true});
      else {
        const rememberedSub = localStorage.getItem('image-workbench.subproject');
        const rememberedMain = localStorage.getItem('image-workbench.project');
        const preferred = subIds.has(rememberedSub) ? rememberedSub
          : (subs.find(sub => sub.main_project_id === rememberedMain) || subs[0])?.subproject_id;
        if (preferred) await selectSubproject(preferred, {preserveDraft: true});
        else {
          $('videoProjectDetail').hidden = true; $('videoProjectIntro').hidden = true;
          $('videoProjectCrumb').textContent = state.mainProjects.length ? '请选择子项目' : '请先新建主项目';
          notice(state.mainProjects.length ? '请在左侧为新项目创建或选择一个子项目' : '请点击左侧 + 新建主项目，再创建子项目');
        }
      }
    }
    if (state.config.is_admin) {
      const panel=el('section','panel');panel.id='videoRecoveryPanel';$('videoNotice').after(panel);
      const button=el('button','secondary-button','管理员：核对视频执行器 / 解除冻结');button.type='button';button.addEventListener('click',()=>busy(button,inspectQueue));panel.before(button);
    }
    document.dispatchEvent(new CustomEvent('video-ready'));
    setInterval(() => { if (!document.hidden && state.account) refresh().catch(error => notice(error.message, true)); }, 8000);
  })().catch(error => notice(error.message, true));
})();
