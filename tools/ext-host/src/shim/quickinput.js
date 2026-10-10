// QuickPick / InputBox completos (`window.createQuickPick`/`createInputBox` e
// os `showQuickPick`/`showInputBox` por cima deles, como no VS Code).
//
// O estado do objeto vai ao app num evento `quickInput` (em lote por
// microtask) a cada mudança — itens, ativos, selecionados, botões, busy,
// mensagem de validação…; `quickInputHide` fecha. O app devolve as interações
// por `quickInputEvent` (value/accept/hide/active/selection/button/itemButton).
// Um quick input por vez: mostrar outro esconde o anterior.
'use strict';
const { EventEmitter, QuickInputButtons } = require('./types');

let nextQuickInput = 1;

function iconOf(button) {
  const p = button && button.iconPath;
  if (p && typeof p.id === 'string') return p.id; // ThemeIcon
  if (button && button.__back) return 'arrow-left';
  return undefined;
}

function describeButtons(buttons) {
  return (buttons || []).slice(0, 16).map((b, index) => ({ index, icon: iconOf(b), tooltip: b && b.tooltip ? String(b.tooltip) : undefined, back: !!(b && (b === QuickInputButtons.Back || b.__back)) }));
}

function validationOf(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'string') return { text: v, severity: 3 };
  if (typeof v === 'object' && v.message) return { text: String(v.message), severity: typeof v.severity === 'number' ? v.severity : 3 };
  return null;
}

class QuickInputService {
  constructor(host) {
    this.host = host;
    this.inputs = new Map(); // id → controller
    this.current = null;
  }

  _create(ext, kind) {
    const service = this;
    const id = `qi${nextQuickInput++}`;
    const em = {
      accept: new EventEmitter(),
      hide: new EventEmitter(),
      value: new EventEmitter(),
      active: new EventEmitter(),
      selection: new EventEmitter(),
      button: new EventEmitter(),
      itemButton: new EventEmitter(),
    };
    const state = {
      title: undefined,
      step: undefined,
      totalSteps: undefined,
      enabled: true,
      busy: false,
      ignoreFocusOut: false,
      placeholder: undefined,
      value: '',
      buttons: [],
      // quick pick
      items: [],
      canSelectMany: false,
      matchOnDescription: false,
      matchOnDetail: false,
      keepScrollPosition: false,
      activeItems: [],
      selectedItems: [],
      sortByLabel: true,
      // input box
      password: false,
      prompt: undefined,
      validationMessage: undefined,
      valueSelection: undefined,
    };
    let visible = false;
    let disposed = false;
    let queued = false;
    const ctl = { id, kind, ext, em, state };
    const flush = () => {
      queued = false;
      if (!visible || disposed) return;
      service.host.emit(service.describe(ctl));
    };
    const schedule = () => {
      if (visible && !queued) {
        queued = true;
        queueMicrotask(flush);
      }
    };
    ctl.schedule = schedule;
    ctl.isVisible = () => visible;
    const obj = {
      show() {
        if (disposed) return;
        if (service.current && service.current !== ctl) service.current.hide(true);
        service.current = ctl;
        visible = true;
        if (!service.host.appConnected) {
          // Sem UI: fecha na hora (como cancelar).
          queueMicrotask(() => ctl.hide(true));
          return;
        }
        schedule();
      },
      hide() {
        ctl.hide(true);
      },
      dispose() {
        if (disposed) return;
        ctl.hide(true);
        disposed = true;
        service.inputs.delete(id);
      },
      onDidAccept: em.accept.event,
      onDidHide: em.hide.event,
      onDidChangeValue: em.value.event,
      onDidTriggerButton: em.button.event,
    };
    ctl.hide = (notifyApp) => {
      if (!visible) return;
      visible = false;
      if (service.current === ctl) service.current = null;
      if (notifyApp) service.host.emit({ event: 'quickInputHide', id });
      em.hide.fire();
    };
    const props = kind === 'pick'
      ? ['title', 'step', 'totalSteps', 'enabled', 'busy', 'ignoreFocusOut', 'placeholder', 'value', 'buttons', 'items', 'canSelectMany', 'matchOnDescription', 'matchOnDetail', 'keepScrollPosition', 'activeItems', 'selectedItems', 'sortByLabel']
      : ['title', 'step', 'totalSteps', 'enabled', 'busy', 'ignoreFocusOut', 'placeholder', 'value', 'buttons', 'password', 'prompt', 'validationMessage', 'valueSelection'];
    for (const key of props) {
      Object.defineProperty(obj, key, {
        enumerable: true,
        get: () => state[key],
        set: (v) => {
          state[key] = key === 'items' || key === 'activeItems' || key === 'selectedItems' || key === 'buttons' ? [...(v || [])] : v;
          if (key === 'items') {
            // Itens novos: ativos/selecionados que não existem mais saem; `picked` vale no multi.
            state.activeItems = state.activeItems.filter((i) => state.items.includes(i));
            state.selectedItems = state.canSelectMany ? state.items.filter((i) => i && i.picked) : state.selectedItems.filter((i) => state.items.includes(i));
          }
          schedule();
        },
      });
    }
    if (kind === 'pick') {
      obj.onDidChangeActive = em.active.event;
      obj.onDidChangeSelection = em.selection.event;
      obj.onDidTriggerItemButton = em.itemButton.event;
    }
    ctl.obj = obj;
    this.inputs.set(id, ctl);
    return obj;
  }

  createQuickPick(ext) {
    return this._create(ext, 'pick');
  }

  createInputBox(ext) {
    return this._create(ext, 'input');
  }

  describe(ctl) {
    const s = ctl.state;
    const base = {
      event: 'quickInput',
      id: ctl.id,
      kind: ctl.kind,
      extensionId: ctl.ext.id,
      title: s.title === undefined ? undefined : String(s.title),
      step: s.step,
      totalSteps: s.totalSteps,
      enabled: s.enabled !== false,
      busy: !!s.busy,
      ignoreFocusOut: !!s.ignoreFocusOut,
      placeholder: s.placeholder === undefined ? undefined : String(s.placeholder),
      value: String(s.value || ''),
      buttons: describeButtons(s.buttons),
    };
    if (ctl.kind === 'input') {
      return { ...base, password: !!s.password, prompt: s.prompt === undefined ? undefined : String(s.prompt), validationMessage: validationOf(s.validationMessage) };
    }
    const items = s.items.slice(0, 5000);
    return {
      ...base,
      canSelectMany: !!s.canSelectMany,
      matchOnDescription: !!s.matchOnDescription,
      matchOnDetail: !!s.matchOnDetail,
      items: items.map((it, index) => ({
        index,
        label: String((it && it.label) || ''),
        description: it && it.description ? String(it.description) : undefined,
        detail: it && it.detail ? String(it.detail) : undefined,
        kind: it && it.kind === -1 ? -1 : 0,
        alwaysShow: !!(it && it.alwaysShow),
        icon: it && it.iconPath && typeof it.iconPath.id === 'string' ? it.iconPath.id : undefined,
        buttons: describeButtons(it && it.buttons),
      })),
      activeIndexes: s.activeItems.map((i) => items.indexOf(i)).filter((i) => i >= 0),
      selectedIndexes: s.selectedItems.map((i) => items.indexOf(i)).filter((i) => i >= 0),
    };
  }

  /** Interação vinda do app. */
  event(p) {
    const ctl = this.inputs.get(p.id);
    if (!ctl || !ctl.isVisible()) return false;
    const s = ctl.state;
    const items = (idx) => (Array.isArray(idx) ? idx.map((i) => s.items[i]).filter((x) => x !== undefined && x.kind !== -1) : []);
    switch (p.type) {
      case 'value':
        if (typeof p.value !== 'string' || p.value === s.value) return true;
        s.value = p.value;
        ctl.em.value.fire(p.value);
        return true;
      case 'active':
        s.activeItems = items(p.indexes);
        ctl.em.active.fire([...s.activeItems]);
        return true;
      case 'selection':
        s.selectedItems = items(p.indexes);
        ctl.em.selection.fire([...s.selectedItems]);
        return true;
      case 'accept':
        if (Array.isArray(p.indexes)) {
          s.selectedItems = items(p.indexes);
          ctl.em.selection.fire([...s.selectedItems]);
        }
        ctl.em.accept.fire();
        return true;
      case 'button': {
        const b = s.buttons[p.button];
        if (b) ctl.em.button.fire(b);
        return true;
      }
      case 'itemButton': {
        const item = s.items[p.item];
        const b = item && item.buttons && item.buttons[p.button];
        if (b) ctl.em.itemButton.fire({ button: b, item });
        return true;
      }
      case 'hide':
        ctl.hide(false);
        return true;
      default:
        return false;
    }
  }

  // ------------------------------------------------ showQuickPick/showInputBox
  showQuickPick(ext, itemsOrPromise, options = {}, token) {
    const qp = this.createQuickPick(ext);
    qp.title = options.title;
    qp.placeholder = options.placeHolder;
    qp.canSelectMany = !!options.canPickMany;
    qp.matchOnDescription = !!options.matchOnDescription;
    qp.matchOnDetail = !!options.matchOnDetail;
    qp.ignoreFocusOut = !!options.ignoreFocusOut;
    qp.busy = true;
    return new Promise((resolve) => {
      let strings = false;
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        qp.dispose();
        resolve(v);
      };
      const unwrap = (list) => (strings ? list.map((i) => i.label) : list);
      qp.onDidAccept(() => {
        if (qp.canSelectMany) finish(unwrap(qp.selectedItems));
        else {
          const pick = qp.selectedItems[0] || qp.activeItems[0];
          if (pick) finish(unwrap([pick])[0]);
        }
      });
      qp.onDidHide(() => finish(undefined));
      if (typeof options.onDidSelectItem === 'function') qp.onDidChangeActive((a) => a[0] && options.onDidSelectItem(strings ? a[0].label : a[0]));
      if (token && typeof token.onCancellationRequested === 'function') token.onCancellationRequested(() => finish(undefined));
      qp.show();
      Promise.resolve(itemsOrPromise).then(
        (list) => {
          const arr = list || [];
          strings = arr.length > 0 && typeof arr[0] === 'string';
          qp.items = strings ? arr.map((label) => ({ label })) : arr;
          if (qp.canSelectMany) qp.selectedItems = qp.items.filter((i) => i.picked);
          qp.busy = false;
        },
        () => finish(undefined),
      );
    });
  }

  showInputBox(ext, options = {}, token) {
    const box = this.createInputBox(ext);
    box.title = options.title;
    box.placeholder = options.placeHolder;
    box.prompt = options.prompt;
    box.password = !!options.password;
    box.ignoreFocusOut = !!options.ignoreFocusOut;
    box.value = options.value || '';
    box.valueSelection = options.valueSelection;
    const validate = typeof options.validateInput === 'function' ? options.validateInput : null;
    return new Promise((resolve) => {
      let done = false;
      let seq = 0;
      let lastError = null;
      const finish = (v) => {
        if (done) return;
        done = true;
        box.dispose();
        resolve(v);
      };
      const check = async (value) => {
        if (!validate) return null;
        const my = ++seq;
        let r;
        try {
          r = await validate(value);
        } catch (err) {
          r = err && err.message ? err.message : String(err);
        }
        if (my !== seq) return undefined; // resposta velha
        const msg = validationOf(r);
        box.validationMessage = msg ? { message: msg.text, severity: msg.severity } : undefined;
        lastError = msg && msg.severity === 3 ? msg : null;
        return msg;
      };
      box.onDidChangeValue((v) => void check(v));
      box.onDidAccept(async () => {
        const value = box.value;
        await check(value);
        if (lastError) return; // erro de validação: continua aberto
        finish(value);
      });
      box.onDidHide(() => finish(undefined));
      if (token && typeof token.onCancellationRequested === 'function') token.onCancellationRequested(() => finish(undefined));
      box.show();
      void check(box.value);
    });
  }
}

module.exports = { QuickInputService, validationOf, describeButtons };
