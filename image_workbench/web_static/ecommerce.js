(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const uid = () => crypto.randomUUID().replaceAll('-', '');
  let csrf = '', wid = '', templates = [], selected = 'clothing-model', plan = null, purchase = null;
  const api = window.WorkbenchApi.create({getWorkspaceId: () => wid, getCsrfToken: () => csrf, onUnauthorized: () => { location.href = '/login'; }});
  const message = value => { $('message').textContent = value; };
  function el(tag, text, className) { const n = document.createElement(tag); if (text) n.textContent = text; if (className) n.className = className; return n; }
  async function busy(button, action) { button.disabled = true; try { await action(); } catch (err) { message(err.message); } finally { button.disabled = false; } }
  function choose(id) {
    selected = id; plan = null; purchase = null; $('planSection').hidden = true;
    $('modelField').hidden = id !== 'clothing-model';
    document.querySelectorAll('.template').forEach(n => { n.classList.toggle('selected', n.dataset.id === id); n.setAttribute('aria-pressed', String(n.dataset.id === id)); });
    const t = templates.find(n => n.id === id); $('plan').textContent = `展开 ${t.image_count} 张内容与提示词`; $('price').textContent = t.package_credit; $('original').textContent = t.original_credit;
  }
  function renderTemplates() {
    for (const t of templates) {
      const b = el('button', '', 'template'); b.dataset.id = t.id;
      const img = el('img'); img.src = `/static/ecommerce-examples/${t.id}/cover.webp`; img.alt = t.name + '案例预览';
      img.onerror = () => img.replaceWith(el('div', t.with_model ? '服装 · 同一位模特' : '小商品 · 无人物', 'placeholder'));
      const copy = el('div', '', 'copy'); copy.append(el('h2', t.name), el('p', t.description), el('strong', `${t.package_credit} 积分 / ${t.image_count} 张 · 五折`)); b.append(img, copy); b.onclick = () => choose(t.id); const wrapper = el('div');
      const examples = el('details', '', 'examples'); examples.append(el('summary', `查看 ${t.image_count} 张案例`));
      const gallery = el('div', '', 'example-grid');
      for(const slot of t.slots) { const a=el('a'), sample=el('img'); a.href=`/static/ecommerce-examples/${t.id}/${slot.example_image || slot.id+'.webp'}`;a.target='_blank';a.rel='noopener';sample.src=a.href;sample.loading='lazy';sample.alt=`${slot.id} · ${slot.name}`;a.append(sample);gallery.append(a); }
      examples.append(gallery);wrapper.append(b,examples);$('templates').append(wrapper);
    }
    const requested = new URLSearchParams(location.search).get('template');
    choose(templates.some(t => t.id === requested) ? requested : selected);
  }
  $('plan').onclick = () => busy($('plan'), async () => {
    if (!$('product').value.trim()) throw new Error('请填写商品信息');
    plan = await api('/api/ecommerce/plan', {method:'POST', body:JSON.stringify({template_id:selected, product:$('product').value, model_description:$('model').value})});
    purchase = null; $('slots').replaceChildren();
    plan.slots.forEach((slot, i) => {
      const card = el('div', '', 'slot'), input = el('textarea'); input.value = slot.prompt; input.maxLength = 12000; input.setAttribute('aria-label', slot.name + '提示词'); input.dataset.index = i;
      const enhance = el('button','用套图 Skill 优化','secondary');
      enhance.onclick = () => busy(enhance, async () => {
        const response = await api('/api/prompt-enhancements', {method:'POST', body:JSON.stringify({request_id:uid(), prompt:input.value, mode:'standard', task_type:'reference_generate', skill_id:plan.editing_skill_id, aspect_ratio:'1:1', references:[{index:1, role:'product', usage:'商品外观事实参考'}]})});
        if (response.enhanced_prompt) input.value = response.enhanced_prompt;
        message(response.fallback?.message || '提示词已更新，可继续手动编辑。');
      });
      card.append(el('h3', `${slot.id} · ${slot.name}`), input, enhance); $('slots').append(card);
    });
    $('quote').textContent = `${plan.image_count} 张 · 原价 ${plan.original_credit} · 五折 ${plan.package_credit} 积分`;
    $('planSection').hidden = false; message('内容清单已准备好。上传商品参考图后即可生成。');
  });
  $('submit').onclick = () => busy($('submit'), async () => {
    if (!plan) throw new Error('请先展开套图内容');
    const prompts = [...$('slots').querySelectorAll('textarea')].map(n => n.value);
    const files = [...$('files').files];
    if (!files.length || files.length > 8 || files.some(f => f.size > 20*1024*1024) || files.reduce((n,f) => n+f.size,0)>40*1024*1024) throw new Error('请上传 1–8 张参考图，单张最多20MB，合计最多40MB');
    // Keep IDs after network errors. Repeating a submission confirms the same purchase.
    if (!purchase) purchase = {projectId:uid(), subId:uid(), requestId:uid()};
    const p = purchase;
    message('正在保存参考图与整套任务…');
    await api('/api/main-projects', {method:'POST',body:JSON.stringify({request_id:p.projectId,name:plan.name+' · '+$('product').value.slice(0,35)})});
    await api(`/api/main-projects/${p.projectId}/subprojects`,{method:'POST',body:JSON.stringify({request_id:p.subId,name:`${plan.image_count}张套图`})});
    if (!p.refs) { const form = new FormData(); files.forEach(f => form.append('files',f)); const result = await api(`/api/subprojects/${p.subId}/assets`,{method:'POST',body:form}); p.refs = result.assets.map(a => a.artifact_id); }
    const result = await api(`/api/main-projects/${p.projectId}/suites`,{method:'POST',body:JSON.stringify({request_id:p.requestId, template_id:plan.id, subproject_id:p.subId, reference_artifact_ids:p.refs, prompts, confirm_generation:true})});
    message(`已受理 ${result.tasks.length} 张，套餐 ${result.package_credit} 积分。正在排队生成。`);
    $('planSection').hidden = true; plan = null; purchase = null; await history();
  });
  async function history() {
    const projects = await api('/api/main-projects'); const holder = $('history'); holder.replaceChildren();
    for (const project of projects.main_projects) {
      const data = await api(`/api/main-projects/${project.main_project_id}/suites`);
      for (const suite of data.suites) {
        const box = el('div','','suite'), heading = el('h3',suite.name), download = el('a','下载已完成图片 ZIP');
        download.href = `/api/main-projects/${suite.project_id}/suites/${suite.suite_id}/download?workspace_id=${encodeURIComponent(wid)}`; heading.append(download); box.append(heading);
        box.append(el('p',`${suite.package_credit} 积分 / ${suite.image_count} 张 · ${suite.tasks.filter(t => t.outputs?.length).length} 张已完成`));
        if(suite.status === 'preparing') {
          const resume=el('button','继续提交整套');
          resume.onclick=()=>busy(resume,async()=>{await api(`/api/main-projects/${suite.project_id}/suites`,{method:'POST',body:JSON.stringify({request_id:suite.suite_id,template_id:suite.template_id,subproject_id:suite.subproject_id,reference_artifact_ids:suite.reference_artifact_ids,prompts:suite.slots.map(s=>s.prompt),confirm_generation:true})});message('整套已提交');await history();});box.append(resume);
        }
        const grid = el('div','','results');
        for (const task of suite.tasks) {
          const card = el('div','','result');
          for (const output of task.outputs || []) { const a = el('a'), img = el('img'); a.href = output.url; a.target='_blank'; a.rel='noopener'; img.src=output.url; img.alt=task.name; a.append(img); card.append(a); }
          card.append(el('p',task.name),el('p',task.status_label || task.status));
          if(task.can_retry && task.current_job) { const retry=el('button',`重试 · ${suite.unit_credit} 积分`); retry.onclick=()=>busy(retry,async()=>{await api(`/api/tasks/${task.task_id}/run`,{method:'POST',body:JSON.stringify({request_id:uid(),confirm_generation:true,retry_of:task.current_job.job_id})});await history();});card.append(retry); }
          grid.append(card);
        }
        box.append(grid);holder.append(box);
      }
    }
    if(!holder.children.length)holder.append(el('p','还没有套图。选择模板，上传商品图开始。'));
  }
  $('refresh').onclick=()=>busy($('refresh'),history);
  (async()=>{try{ const me=await api('/api/auth/me'); wid=me.workspace?.workspace_id || me.workspace_id || ''; const config=await api('/api/config');csrf=config.csrf_token; $('account').textContent=me.username || '';templates=(await api('/api/ecommerce/templates')).templates;renderTemplates();await history();}catch(e){message(e.message);}})();
})();
