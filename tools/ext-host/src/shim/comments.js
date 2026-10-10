// `vscode.comments` → threads de comentário renderizados no Monaco do app
// (view zones com estilo Fluent; ver src/extensions/commentWidgets.ts).
//
// Cada CommentThread vira um evento `commentThread` (upsert, em lote por
// microtask) com as AÇÕES já resolvidas dos menus contribuídos
// (`comments/commentThread/title|context`, `comments/comment/title|context`)
// cujo `when` vale para aquele thread (`commentController`, `commentThread`,
// `comment`…). O app só pode executar essas ações (`commentAction`): o host
// confere o comando contra a lista calculada e passa o thread/comentário REAL
// como argumento — é assim que o Claude Code aceita/rejeita um hunk pela barra
// (`claude-vscode.acceptProposedHunkFromBar(thread)`).
'use strict';
const { Range, Disposable, CancellationTokenSource } = require('./types');

let nextThread = 1;

const MENU_KEYS = {
  threadTitle: 'comments/commentThread/title',
  threadContext: 'comments/commentThread/context',
  commentTitle: 'comments/comment/title',
  commentContext: 'comments/comment/context',
};

function markdownText(m) {
  if (m && typeof m === 'object') return String(m.value || '');
  return String(m == null ? '' : m);
}

function plainRange(r) {
  if (!r || !r.start || !r.end) return null;
  return { start: { line: r.start.line, character: r.start.character }, end: { line: r.end.line, character: r.end.character } };
}

/** `$(check)` → `check` (codicon); objetos de ícone/caminhos não são repassados. */
function iconName(icon) {
  const m = typeof icon === 'string' ? /^\$\(([\w-]+)(?:~[\w-]+)?\)$/.exec(icon) : null;
  return m ? m[1] : undefined;
}

class CommentService {
  /** @param {object} host ExtensionHost */
  constructor(host) {
    this.host = host;
    this.threads = new Map(); // handle → thread
    this.controllers = new Set();
    this._dirty = new Set();
    this._queued = false;
  }

  createController(ext, id, label) {
    const service = this;
    const threads = new Set();
    const controller = {
      get id() {
        return id;
      },
      get label() {
        return label;
      },
      options: undefined,
      commentingRangeProvider: undefined,
      reactionHandler: undefined,
      createCommentThread(uri, range, comments) {
        const t = service._createThread(ext, controller, uri, range, comments || []);
        threads.add(t);
        t._threads = threads;
        return t;
      },
      dispose() {
        for (const t of [...threads]) t.dispose();
        service.controllers.delete(entry);
      },
    };
    const entry = { ext, controller, threads };
    this.controllers.add(entry);
    return controller;
  }

  _createThread(ext, controller, uri, range, comments) {
    const service = this;
    const handle = `ct${nextThread++}`;
    const state = {
      uri,
      range,
      comments: Array.isArray(comments) ? comments : [],
      collapsibleState: 0,
      canReply: true,
      contextValue: undefined,
      label: undefined,
      state: undefined,
    };
    let disposed = false;
    const thread = {
      get uri() {
        return state.uri;
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        service.threads.delete(handle);
        service._dirty.delete(handle);
        if (thread._threads) thread._threads.delete(thread);
        service.host.emit({ event: 'commentThreadDisposed', handle });
      },
    };
    for (const key of ['range', 'comments', 'collapsibleState', 'canReply', 'contextValue', 'label', 'state']) {
      Object.defineProperty(thread, key, {
        enumerable: true,
        get: () => state[key],
        set: (v) => {
          state[key] = v;
          if (!disposed) service._schedule(handle);
        },
      });
    }
    Object.defineProperty(thread, '_handle', { value: handle });
    Object.defineProperty(thread, '_ext', { value: ext });
    Object.defineProperty(thread, '_controller', { value: controller });
    Object.defineProperty(thread, '_disposed', { get: () => disposed });
    this.threads.set(handle, thread);
    this._schedule(handle);
    return thread;
  }

  _schedule(handle) {
    this._dirty.add(handle);
    if (this._queued) return;
    this._queued = true;
    queueMicrotask(() => {
      this._queued = false;
      const list = [...this._dirty];
      this._dirty.clear();
      for (const h of list) {
        const t = this.threads.get(h);
        if (t) this.host.emit(this.describe(t));
      }
    });
  }

  /** Comandos (título + ícone) contribuídos pela extensão dona do thread. */
  _commandInfo(ext, command) {
    const c = ext.contributions.commands.find((x) => x.command === command) || {};
    return { command, title: c.title || command, icon: iconName(c.icon) };
  }

  _actions(thread, key, extra) {
    const ext = thread._ext;
    const menus = (ext.contributions.menus && ext.contributions.menus[key]) || [];
    const out = [];
    for (const m of menus) {
      if (!this.host.evaluateWhen(m.when, extra)) continue;
      out.push({ ...this._commandInfo(ext, m.command), group: m.group });
    }
    return out;
  }

  _ctx(thread, comment) {
    return {
      commentController: thread._controller.id,
      commentThread: thread.contextValue,
      commentThreadIsEmpty: thread.comments.length === 0,
      comment: comment ? comment.contextValue : undefined,
      commentIsEmpty: comment ? !markdownText(comment.body) : undefined,
    };
  }

  describe(thread) {
    const uri = thread.uri && typeof thread.uri.toString === 'function' ? thread.uri.toString() : String(thread.uri);
    return {
      event: 'commentThread',
      handle: thread._handle,
      extensionId: thread._ext.id,
      controllerId: thread._controller.id,
      controllerLabel: thread._controller.label,
      uri,
      path: thread.uri && thread.uri.scheme === 'file' ? thread.uri.fsPath : undefined,
      range: plainRange(thread.range),
      label: thread.label === undefined ? undefined : String(thread.label),
      contextValue: thread.contextValue,
      collapsibleState: thread.collapsibleState === 1 ? 1 : 0,
      canReply: thread.canReply !== false,
      state: thread.state,
      comments: (thread.comments || []).slice(0, 200).map((c, index) => ({
        index,
        body: markdownText(c.body).slice(0, 64 * 1024),
        author: c.author && c.author.name ? String(c.author.name) : '',
        label: c.label ? String(c.label) : undefined,
        contextValue: c.contextValue,
        mode: c.mode,
        timestamp: c.timestamp instanceof Date ? c.timestamp.toISOString() : undefined,
        reactions: (c.reactions || []).slice(0, 32).map((r) => ({ label: String(r.label || ''), count: Number(r.count) || 0, authorHasReacted: !!r.authorHasReacted })),
        actions: this._actions(thread, MENU_KEYS.commentTitle, this._ctx(thread, c)),
        contextActions: this._actions(thread, MENU_KEYS.commentContext, this._ctx(thread, c)),
      })),
      actions: this._actions(thread, MENU_KEYS.threadTitle, this._ctx(thread)),
      replyActions: this._actions(thread, MENU_KEYS.threadContext, this._ctx(thread)),
      canReact: typeof thread._controller.reactionHandler === 'function',
    };
  }

  /**
   * Botão de um thread clicado no app. Só comandos que o próprio thread
   * oferece (menus contribuídos com `when` válido) são aceitos.
   */
  async action({ handle, command, commentIndex, text }) {
    const thread = this.threads.get(handle);
    if (!thread) return { ok: false, error: 'thread não existe mais' };
    const d = this.describe(thread);
    if (typeof commentIndex === 'number') {
      const c = d.comments[commentIndex];
      const comment = thread.comments[commentIndex];
      if (!c || !comment || ![...c.actions, ...c.contextActions].some((a) => a.command === command)) return { ok: false, error: 'ação não oferecida por este comentário' };
      await this.host.executeCommand(command, comment);
      return { ok: true };
    }
    if (d.actions.some((a) => a.command === command)) {
      await this.host.executeCommand(command, thread);
      return { ok: true };
    }
    if (d.replyActions.some((a) => a.command === command)) {
      await this.host.executeCommand(command, { thread, text: String(text || '') });
      return { ok: true };
    }
    return { ok: false, error: 'ação não oferecida por este thread' };
  }

  async reaction({ handle, commentIndex, reaction }) {
    const thread = this.threads.get(handle);
    const handler = thread && thread._controller.reactionHandler;
    const comment = thread && thread.comments[commentIndex];
    if (!thread || typeof handler !== 'function' || !comment) return { ok: false };
    const r = (comment.reactions || []).find((x) => x.label === reaction) || { label: String(reaction), count: 0, authorHasReacted: false, iconPath: '' };
    await handler(comment, r);
    this._schedule(handle);
    return { ok: true };
  }

  /** Faixas onde se pode comentar (commentingRangeProvider) para um documento. */
  async commentingRanges(uriString) {
    const out = [];
    let doc;
    for (const { controller } of this.controllers) {
      const prov = controller.commentingRangeProvider;
      if (!prov || typeof prov.provideCommentingRanges !== 'function') continue;
      if (!doc) doc = await this.host.openTextDocument(uriString.includes('://') ? require('./types').Uri.parse(uriString) : uriString).catch(() => null);
      if (!doc) return out;
      try {
        const r = await prov.provideCommentingRanges(doc, new CancellationTokenSource().token);
        const ranges = Array.isArray(r) ? r : r && Array.isArray(r.ranges) ? r.ranges : [];
        out.push({ controllerId: controller.id, ranges: ranges.map(plainRange).filter(Boolean), enableFileComments: !!(r && r.enableFileComments) });
      } catch (err) {
        this.host.log(`provideCommentingRanges (${controller.id}) falhou:`, err);
      }
    }
    return out;
  }

  /** Todos os threads vivos (o app pede ao (re)montar). */
  snapshot() {
    return [...this.threads.values()].map((t) => this.describe(t));
  }
}

module.exports = { CommentService, iconName, MENU_KEYS, Range, Disposable };
