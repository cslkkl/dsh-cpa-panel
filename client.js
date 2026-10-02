/**
 * dsh-cpa-panel —— 浏览器半边。
 *
 * 一个「内置插件」设置分区里的标签页：CPA 各插件的账号面板。
 *
 * 设计要点：
 *  - **按插件分标签**（WorkBuddy / Trae / Qoder / ZCode），一次看一个；
 *  - **按能力降级**：插件不支持的按钮不渲染，而不是给个点了没反应的；
 *  - **单位不混算**：zcode 是 token，workbuddy/qoder 是积分，汇总时分开。
 *
 * 铁律：**管理密钥永远不进这一侧**。所有数据都经宿主半边的 `/api/v1/cpa/*` 取。
 *
 * 本文件是纯 CJS bundle，由 `window.__ModuleLoader__.load` 包装；
 * react 由宿主加载器提供，不打进这一侧。
 */
window.__ModuleLoader__.load({
  id: 'dsh-cpa-panel',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    /**
     * 官方公共 UI 组件库。
     *
     * 它在宿主冻结的 `PLATFORM_MODULES` 静态表里（React / Cordis / 静态 UI 库），
     * 所以**直接 require 即可**，不需要在 package.json 的 `dsh.client.inject`
     * 里声明 —— 官方 `dsh-client-ui-plugin-manager` 就是这么用的
     * （它的 inject 里没有 primitives，却照样 require）。
     *
     * 用官方组件而不是自己写 `.cpa-btn` 这类样式，好处是：
     * 跟随主题 token、明暗一致、焦点环/禁用态/尺寸都已被官方调好。
     */
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const Button = primitives.Button;
    const Switch = primitives.Switch;
    const Tag = primitives.Tag;
    const Pill = primitives.Pill;
    const StateDot = primitives.StateDot;

    const NS = 'cpa-panel';
    const TAB_ID = 'cpa-panel';
    /**
     * **包名**，必须与 package.json 的 `name` 逐字一致。
     *
     * ⚠️ 别拿 `TAB_ID` 当包名用：插件页 `plugins.detail.section` 收到的
     * `subject.pkg.name` 是**完整包名**（`dsh-cpa-panel`），而标签 id 是短名
     * （`cpa-panel`）——两者不相等会让区块**静默不渲染**（不报错，极难查）。
     */
    const PKG_NAME = 'dsh-cpa-panel';

    const zh = {
      tab: 'CPA 面板',
      running: '运行中',
      stopped: '未运行',
      start: '启动',
      noAdminKey: '未配置管理密钥',
      console: '打开 CPA 控制台',
      consoleHint: 'CPA 自带的管理控制台（加账号、改供应商等高级操作在这里）',
      refresh: '刷新',
      checkin: '签到',
      checkinAll: '全部签到',
      tasksAll: '全部任务',
      tasks: '任务',
      inUse: '使用中',
      disabled: '已禁用',
      enable: '启用',
      disable: '禁用',
      enableHint: '重新让这个账号参与调度',
      disableHint: '禁用后这个账号完全不参与调度——这是"只用一个号"的可靠办法',
      addAccount: '添加账号',
      startLogin: '开始登录',
      cancel: '取消',
      loginIntro: '点「开始登录」后会打开该渠道的授权页，在浏览器里完成登录即可，不需要手动复制任何链接。',
      loginHint: '已在浏览器打开授权页。若没有自动打开，点下面的链接：',
      loginWaiting: '等待授权完成…（完成后会自动刷新账号列表）',
      loginFailed: '起登录失败',
      exhausted: '已耗尽',
      remain: '可用',
      used: '已用',
      totalRemain: '剩余（可用）',
      totalUsed: '已用',
      totalPool: '额度池',
      autoCheckin: '自动签到',
      autoCheckinHint: '开启后由 CPA 每天 09:00 / 21:00 自动为所有账号签到',
      loading: '读取中…',
      loadFailed: '读取失败',
      noAccounts: '该插件没有账号',
      checkedIn: '已签到',
      notCheckedIn: '未签到',
      activeHint: '「使用中」按实际请求统计标出',
      streak: '连签',
      days: '天',
      packs: '包',
      unitCredits: '积分',
      unitTokens: 'token',
      models: '模型',
      modelCount: '个模型',
      unitMixed: '（不同插件单位不同，未合并）',
      routing: '账号使用顺序',
      routingHint: '一个账号用满（或不可用）后自动切下一个。这样缓存能留在同一个账号上，命中率高、省积分。',
      strategyLabel: '当前策略',
      strategyFillFirst: '用满再用下一个',
      strategyRoundRobin: '轮换',
      strategyWarn: '每个请求换号，缓存几乎不命中，会明显多花积分',
      priority: '账号优先级',
      priorityHint: '从上到下依次优先；数值越大越优先。首选号用满或不可用时自动切下一个。',
      dragToReorder: '拖动卡片调整顺序',
      priorityNone: '该插件没有可排序的账号。',
      rankFirst: '首选',
      noCredits: '余额未知',
      moveUp: '上移',
      moveDown: '下移',
      dragHint: '拖动调整顺序',
      save: '保存顺序',
      saving: '保存中…',
      saved: '已保存',
      prioritySaved: '优先级已保存',
    };

    const en = {
      tab: 'CPA',
      running: 'Running',
      stopped: 'Stopped',
      start: 'Start',
      noAdminKey: 'No admin key',
      console: 'Open CPA console',
      consoleHint: "CPA's own management console (add accounts, edit providers, etc.)",
      refresh: 'Refresh',
      checkin: 'Check in',
      checkinAll: 'Check in all',
      tasksAll: 'Run all tasks',
      tasks: 'Tasks',
      inUse: 'In use',
      disabled: 'Disabled',
      enable: 'Enable',
      disable: 'Disable',
      enableHint: 'Let this account take part in scheduling again',
      disableHint: 'Fully removes this account from scheduling — the reliable way to use only one',
      addAccount: 'Add account',
      startLogin: 'Start login',
      cancel: 'Cancel',
      loginIntro:
        'Clicking "Start login" opens this channel\'s authorization page. Finish in the browser — no link copying needed.',
      loginHint: 'The authorization page was opened in your browser. If it did not open, use this link:',
      loginWaiting: 'Waiting for authorization… (the account list refreshes automatically)',
      loginFailed: 'Failed to start login',
      exhausted: 'Exhausted',
      remain: 'Available',
      used: 'Used',
      totalRemain: 'Available',
      totalUsed: 'Used',
      totalPool: 'Pool',
      autoCheckin: 'Auto check-in',
      autoCheckinHint: 'When on, CPA checks in every account daily at 09:00 and 21:00',
      loading: 'Loading…',
      loadFailed: 'Load failed',
      noAccounts: 'No accounts',
      checkedIn: 'Checked in',
      notCheckedIn: 'Not checked in',
      activeHint: 'In-use is detected from real request stats',
      streak: 'Streak',
      days: 'd',
      packs: 'packs',
      unitCredits: 'credits',
      unitTokens: 'tokens',
      models: 'Models',
      modelCount: ' models',
      unitMixed: '(units differ per plugin; not merged)',
      routing: 'Account order',
      routingHint: 'Uses one account until exhausted, then moves to the next. Keeps the prompt cache on one account: higher hit rate, fewer credits.',
      strategyLabel: 'Current strategy',
      strategyFillFirst: 'Fill first',
      strategyRoundRobin: 'Round robin',
      strategyWarn: 'switches credentials per request; the cache almost never hits, costing noticeably more',
      priority: 'Account priority',
      priorityHint: 'Top is preferred. Higher number wins. Falls through when exhausted or unavailable.',
      dragToReorder: 'Drag cards to reorder',
      priorityNone: 'No sortable accounts for this plugin.',
      rankFirst: 'First',
      noCredits: 'Balance unknown',
      moveUp: 'Move up',
      moveDown: 'Move down',
      dragHint: 'Drag to reorder',
      save: 'Save order',
      saving: 'Saving…',
      saved: 'Saved',
      prioritySaved: 'Priority saved',
    };

    /** 取数；任何异常收敛成 `{ok:false}`，不抛。 */
    async function api(path, init) {
      try {
        const response = await fetch(path, { credentials: 'include', ...(init ?? {}) });
        const text = await response.text();
        try {
          return text === '' ? {} : JSON.parse(text);
        } catch {
          return { ok: false, error: 'HTTP ' + String(response.status) };
        }
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    }

    /** 发一个写操作。 */
    function act(plugin, kind, authIndex) {
      return api('/api/v1/cpa/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          authIndex === undefined ? { plugin, kind } : { plugin, kind, authIndex },
        ),
      });
    }

    /**
     * 启用 / 禁用账号。
     *
     * 这是"只有一个账号消耗积分"的可靠手段 —— 见 AccountCard 里
     * 「启用 / 禁用」按钮的注释。
     */
    function setAccountEnabled(plugin, authIndex, enabled) {
      return api('/api/v1/cpa/account-enabled', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plugin, authIndex, enabled }),
      });
    }

    /** 起一次渠道登录，返回 `{ok, state, url}`。 */
    function startAuth(plugin) {
      return api('/api/v1/cpa/auth?plugin=' + encodeURIComponent(plugin));
    }

    /** 查登录进度。返回 `{ok, status}`，`status==='wait'` 表示还没完成。 */
    function authStatus(state) {
      return api('/api/v1/cpa/auth?state=' + encodeURIComponent(state));
    }

    /** 取消登录会话。 */
    function authCancel(state) {
      return api('/api/v1/cpa/auth?state=' + encodeURIComponent(state), { method: 'DELETE' });
    }

    /** 数字千分位。 */
    function fmt(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
      return value.toLocaleString('en-US');
    }

    /** 单张账号卡。 */
    function AccountCard(props) {
      const { account, capabilities, t } = props;
      /** 真实在用的 authId（由 host 从请求统计算出），不是账号自己的 selected。 */
      const isActive = props.activeAuthId !== null && props.activeAuthId === account.authId;
      const [busy, setBusy] = React.useState('');

      const credits = account.credits;
      const remain = credits === null ? undefined : credits.remain;
      const used = credits === null ? undefined : credits.used;
      const percent =
        credits !== null && credits.size > 0
          ? Math.round((Number(credits.used ?? 0) / Number(credits.size)) * 100)
          : 0;

      const run = async (kind) => {
        setBusy(kind);
        try {
          const result = await act(props.plugin, kind, account.authIndex);
          props.onToast(
            t(kind) + (result?.ok === true ? ' ✓' : ' ✗'),
            result?.ok === true ? 'ok' : 'err',
            result?.error,
          );
          if (result?.ok === true) await props.onReload();
        } finally {
          setBusy('');
        }
      };

      /** 切启用 / 禁用。禁用是这个渠道"只用一个号"的可靠手段。 */
      const toggleEnabled = async () => {
        setBusy('toggle');
        try {
          const next = account.disabled === true;
          const result = await setAccountEnabled(props.plugin, account.authIndex, next);
          props.onToast(
            (next ? t('enable') : t('disable')) + (result?.ok === true ? ' ✓' : ' ✗'),
            result?.ok === true ? 'ok' : 'err',
            result?.error,
          );
          if (result?.ok === true) await props.onReload();
        } finally {
          setBusy('');
        }
      };

      const badges = [];
      /**
       * 「使用中」按**实际调度**打标，不看 `account.selected`。
       *
       * 两者会不一致：`selected` 是插件面板记的"首选项"，而真正决定扣哪个号
       * 的是 CPA 的调度器（strategy + priority）。曾经出现过面板标"陈盛泷使用中"
       * 但实际一直在扣 cherry 的分。
       */
      // Tag 的 tone 语义：solid=当前选中项、success=健康/已签到、outline=只读事实
      if (isActive) badges.push(React.createElement(Tag, { tone: 'solid', key: 'sel' }, t('inUse')));
      if (account.disabled) badges.push(React.createElement(Tag, { tone: 'danger', key: 'dis' }, t('disabled')));
      if (account.exhausted) badges.push(React.createElement(Tag, { tone: 'warning', key: 'exh' }, t('exhausted')));
      if (account.checkin !== undefined) {
        badges.push(
          React.createElement(
            Tag,
            { tone: account.checkin.checkedToday ? 'success' : 'outline', key: 'ck' },
            account.checkin.checkedToday ? t('checkedIn') : t('notCheckedIn'),
          ),
        );
      }
      if (account.checkin?.streakDays > 0) {
        badges.push(
          React.createElement(Tag, { tone: 'quiet', key: 'st' },
            t('streak') + ' ' + String(account.checkin.streakDays) + t('days')),
        );
      }

      const actions = [];
      /**
       * 这里**没有**「选用」按钮。
       *
       * 曾经有，实测确认它**对请求去向零影响** ——
       * `/v0/management/plugins/<id>/select` 只改插件面板自己记的状态，
       * 选 cherry、选小满，请求照样走调度器挑的那个号。
       *
       * 真正决定用哪个账号的是 `priority`（用管理接口写，见
       * docs/ARCHITECTURE.md 与 .agents/notes/priority-via-api-2026-10-02.md），
       * 面板里用「账号使用顺序」的拖动排序控制。
       * 留一个点了不生效的按钮，比没有更糟。
       */
      if (capabilities.checkin) {
        actions.push(React.createElement(Button, {
          key: 'checkin', variant: 'outline', size: 'sm', disabled: busy !== '',
          onClick: () => void run('checkin'),
        }, t('checkin')));
      }
      if (capabilities.tasks) {
        actions.push(React.createElement(Button, {
          key: 'tasks', variant: 'outline', size: 'sm', disabled: busy !== '',
          onClick: () => void run('tasks'),
        }, t('tasks')));
      }
      /**
       * 启用 / 禁用账号。
       *
       * **这是"只有一个账号消耗积分"的可靠手段**：
       *  - `priority` 只是"尽量先用高的"，高的不可用时会降级到别人；
       *  - `fill-first` 取"第一个可用凭据"，首选号瞬时冷却就切走；
       *  - 只有**禁用**是"根本不参与"，没有降级空间。
       *
       * 禁用后**没有兜底** —— 该渠道唯一的号不可用时请求会直接失败。
       * 这是刻意的：宁可失败也不要偷偷换号把缓存打散。
       */
      actions.push(React.createElement(Button, {
        key: 'toggle',
        variant: account.disabled ? 'primary' : 'ghost',
        size: 'sm',
        disabled: busy !== '',
        title: account.disabled ? t('enableHint') : t('disableHint'),
        onClick: () => void toggleEnabled(),
      }, account.disabled ? t('enable') : t('disable')));

      const meta = [];
      if (credits !== null && credits.packCount > 0) {
        meta.push(String(credits.packCount) + ' ' + t('packs'));
      }
      if (credits?.plan !== undefined) meta.push(String(credits.plan));
      if (credits?.remainKnown === false) meta.push(t('remain') + ' ?');

      return React.createElement(
        'div',
        { className: 'cpa-card' + (isActive ? ' sel' : '') },
        React.createElement(
          'div',
          { className: 'cpa-card-head' },
          React.createElement('span', { className: 'cpa-nick' }, account.nickname),
          ...badges,
        ),
        credits === null
          ? React.createElement('div', { className: 'cpa-muted' }, '—')
          : React.createElement(
              'div',
              { className: 'cpa-nums' },
              React.createElement('div', { className: 'cpa-num' },
                React.createElement('span', { className: 'cpa-lbl' }, t('remain')),
                React.createElement('span', { className: 'cpa-val' }, fmt(remain)),
              ),
              React.createElement('div', { className: 'cpa-num' },
                React.createElement('span', { className: 'cpa-lbl' }, t('used')),
                React.createElement('span', { className: 'cpa-val' }, fmt(used)),
              ),
            ),
        credits !== null && credits.size > 0
          ? React.createElement('div', { className: 'cpa-bar' },
              React.createElement('div', { className: 'cpa-fill', style: { width: String(percent) + '%' } }))
          : null,
        meta.length > 0
          ? React.createElement('div', { className: 'cpa-meta' }, meta.join(' · '))
          : null,
        actions.length > 0
          ? React.createElement('div', { className: 'cpa-actions' }, ...actions)
          : null,
      );
    }

    /** 一个插件的面板。 */
    function PluginPanel(props) {
      const { plugin, meta, t } = props;
      const capabilities = meta.capabilities;
      const [state, setState] = React.useState({ phase: 'loading' });
      const [auto, setAuto] = React.useState(null);
      const [toast, setToast] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      /**
       * 添加账号的弹窗状态。
       *
       * `null`             —— 弹窗关闭
       * `{phase:'idle'}`   —— 刚打开，还没起登录
       * `{phase:'wait', url, state}` —— 等用户去浏览器授权，正在轮询
       * `{phase:'error', error}`     —— 起登录失败
       */
      const [login, setLogin] = React.useState(null);

      /** 起一次登录。 */
      const startLogin = React.useCallback(async () => {
        setLogin({ phase: 'starting' });
        const result = await startAuth(plugin);
        if (result?.ok !== true) {
          setLogin({ phase: 'error', error: String(result?.error ?? 'failed') });
          return;
        }
        // 顺便自动打开一次授权页 —— 但保留链接让用户能手动再点
        try {
          globalThis.open(result.url, '_blank', 'noreferrer');
        } catch {
          /* 弹窗被拦就算了，界面上有链接 */
        }
        setLogin({ phase: 'wait', url: result.url, state: result.state });
      }, [plugin]);

      /** 关闭弹窗时顺手取消 CPA 侧的会话，避免留下悬挂状态。 */
      const closeLogin = React.useCallback(async () => {
        if (login !== null && login.state !== undefined) await authCancel(login.state);
        setLogin(null);
      }, [login]);

      const load = React.useCallback(async () => {
        setState({ phase: 'loading' });
        const accountsResponse = await api('/api/v1/cpa/accounts?plugin=' + encodeURIComponent(plugin));
        if (capabilities.autoCheckin) {
          const autoResponse = await api('/api/v1/cpa/auto-checkin?plugin=' + encodeURIComponent(plugin));
          setAuto(autoResponse?.enabled === true);
        } else {
          setAuto(null);
        }
        if (accountsResponse?.ok !== true) {
          setState({ phase: 'error', error: accountsResponse?.error ?? 'unknown' });
          return;
        }
        const accounts = accountsResponse.data?.accounts ?? [];
        let remain = 0;
        let used = 0;
        let size = 0;
        for (const account of accounts) {
          if (account.credits === null) continue;
          remain += Number(account.credits.remain ?? 0);
          used += Number(account.credits.used ?? 0);
          size += Number(account.credits.size ?? 0);
        }
        setState({
          phase: 'ready',
          accounts,
          // 真实在用的号（null 表示还没有任何请求，不猜）
          activeAuthId: accountsResponse.data?.active?.authId ?? null,
          activeSince: accountsResponse.data?.active?.since ?? null,
          remain,
          used,
          size,
        });
        // 上报给父级，供"账号使用顺序"卡片复用（避免再拉一次接口）
        props.onAccounts?.({
          accounts,
          activeAuthId: accountsResponse.data?.active?.authId ?? null,
        });
      }, [plugin, capabilities.autoCheckin]);

      React.useEffect(() => {
        void load();
      }, [load]);

      /**
       * 轮询登录状态。
       *
       * ⚠️ 必须放在 `load` 定义**之后** —— 依赖数组里引用了它。
       * 放前面会触发 `Cannot access 'load' before initialization`：
       * const 的暂时性死区，是**运行时报错**而不是编译期，很容易漏掉。
       *
       * CPA 在用户完成授权后会自动写好认证文件，所以这里只要等到
       * 状态不再是 `wait` 就重新拉账号列表。
       */
      React.useEffect(() => {
        if (login === null || login.phase !== 'wait') return undefined;
        const timer = setInterval(async () => {
          const result = await authStatus(login.state);
          if (result?.ok !== true) return;
          if (result.status === 'wait') return;
          clearInterval(timer);
          setLogin(null);
          await load();
        }, 2500);
        return () => clearInterval(timer);
      }, [login, load]);

      const runAll = async (kind) => {
        setBusy(true);
        try {
          const result = await act(plugin, kind);
          setToast({
            text: t(kind) + (result?.ok === true ? ' ✓' : ' ✗'),
            kind: result?.ok === true ? 'ok' : 'err',
            detail: result?.error,
          });
          if (result?.ok === true) await load();
        } finally {
          setBusy(false);
        }
      };

      const toggleAuto = async (next) => {
        setBusy(true);
        try {
          const result = await api('/api/v1/cpa/auto-checkin?plugin=' + encodeURIComponent(plugin), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: next }),
          });
          if (result?.ok === true) {
            setAuto(result.enabled === true);
            setToast({ text: t('autoCheckin') + (result.enabled ? ' ✓' : ' ✗'), kind: 'ok' });
          } else {
            setToast({ text: t('autoCheckin') + ' ✗', kind: 'err', detail: result?.error });
          }
        } finally {
          setBusy(false);
        }
      };

      const children = [];

      if (state.phase === 'ready') {
        // 汇总（只有该插件有余额能力才显示）
        if (capabilities.credits && state.accounts.some((a) => a.credits !== null)) {
          children.push(
            React.createElement('div', { className: 'cpa-sum', key: 'sum' },
              React.createElement('div', { className: 'cpa-sumc' },
                React.createElement('span', { className: 'cpa-lbl' }, t('totalRemain')),
                React.createElement('span', { className: 'cpa-sumv' }, fmt(state.remain))),
              React.createElement('div', { className: 'cpa-sumc' },
                React.createElement('span', { className: 'cpa-lbl' }, t('totalUsed')),
                React.createElement('span', { className: 'cpa-sumv' }, fmt(state.used))),
              React.createElement('div', { className: 'cpa-sumc' },
                React.createElement('span', { className: 'cpa-lbl' }, t('totalPool')),
                React.createElement('span', { className: 'cpa-sumv' }, fmt(state.size))),
              React.createElement('div', { className: 'cpa-sumc' },
                React.createElement('span', { className: 'cpa-lbl' }, '单位'),
                React.createElement('span', { className: 'cpa-sumv cpa-unit' },
                  meta.unit === 'tokens' ? t('unitTokens') : t('unitCredits'))),
            ),
          );
        }

        const toolbar = [
          React.createElement(Button, {
            key: 'refresh', variant: 'outline', size: 'sm', disabled: busy,
            onClick: () => void load(),
          }, t('refresh')),
        ];
        if (capabilities.checkin) {
          toolbar.push(React.createElement(Button, {
            key: 'checkinAll', variant: 'primary', size: 'sm', disabled: busy,
            onClick: () => void runAll('checkin'),
          }, t('checkinAll')));
        }
        // 全部任务：把每个号的成长中心任务跑一遍（活动上报/补签卡/接取领取/好友旅行/连签兑换/抽奖）
        if (capabilities.tasks) {
          toolbar.push(React.createElement(Button, {
            key: 'tasksAll', variant: 'outline', size: 'sm', disabled: busy,
            onClick: () => void runAll('tasks'),
          }, t('tasksAll')));
        }
        if (capabilities.autoCheckin) {
          /**
           * 自动签到开关。
           *
           * ⚠️ `Switch` 的 `label` 是**无障碍名，不显示在界面上** —— 只给一个裸开关，
           * 用户根本不知道它管什么。所以要自己配一行可见文字。
           */
          toolbar.push(React.createElement('label', { className: 'cpa-switch', key: 'auto' },
            React.createElement(Switch, {
              checked: auto === true,
              disabled: busy,
              label: t('autoCheckin'),
              title: t('autoCheckinHint'),
              onChange: (next) => void toggleAuto(next),
            }),
            React.createElement('span', { className: 'cpa-switch-text', title: t('autoCheckinHint') },
              t('autoCheckin')),
          ));
        }
        children.push(React.createElement('div', { className: 'cpa-toolbar', key: 'tb' }, ...toolbar));

        /**
         * 「使用中」的说明。
         *
         * 放在**卡片列表正上方**（而不是工具栏里），因为它解释的是下面那些卡片上的
         * 徽标，不是上面的按钮。之前夹在工具栏和卡片之间、又没有视觉归属，
         * 很容易被误读成"自动签到的提示"。
         */
        if (state.activeAuthId !== null) {
          children.push(
            React.createElement(
              'div',
              { className: 'cpa-active-note', key: 'activeHint' },
              t('activeHint') +
                '（' +
                String(state.accounts.find((a) => a.authId === state.activeAuthId)?.nickname ?? '') +
                (state.activeSince === null ? '' : ' · ' + String(state.activeSince)) +
                '）',
            ),
          );
        }

        /**
         * 账号网格 + 「+ 添加账号」卡片。
         *
         * 添加卡片**始终**渲染（空列表时它是唯一入口），所以不再用
         * 「有账号才画网格」的分支 —— 空列表也画网格，里面只有添加卡片。
         */
        children.push(
          React.createElement('div', { className: 'cpa-grid', key: 'grid' },
            ...state.accounts.map((account) =>
              React.createElement(AccountCard, {
                key: account.authIndex,
                account,
                plugin,
                capabilities,
                t,
                activeAuthId: state.activeAuthId,
                onToast: (text, kind, detail) => setToast({ text, kind, detail }),
                onReload: load,
              }),
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                key: '__add__',
                className: 'cpa-addcard',
                onClick: () => setLogin({ phase: 'idle' }),
              },
              React.createElement('span', { className: 'cpa-addplus' }, '+'),
              React.createElement('span', null, t('addAccount')),
            ),
          ),
        );
      }

      if (state.phase === 'loading') {
        children.push(React.createElement('div', { className: 'cpa-empty', key: 'load' }, t('loading')));
      }
      if (state.phase === 'error') {
        children.push(
          React.createElement('div', { className: 'cpa-empty', key: 'err' },
            t('loadFailed') + '：' + String(state.error ?? '')),
        );
      }
      if (toast !== null) {
        children.push(
          React.createElement('div', { className: 'cpa-toast ' + toast.kind, key: 'toast' },
            toast.text + (toast.detail === undefined ? '' : '（' + String(toast.detail) + '）')),
        );
      }

      /**
       * 添加账号的弹窗。
       *
       * 流程：本地起一次 CPA 登录会话 → 打开上游授权页 → 轮询直到完成。
       * **不需要用户手动粘贴回调 URL** —— 本机模式下 CPA 自己收回调并保存凭据。
       */
      if (login !== null) {
        const body =
          login.phase === 'wait'
            ? [
                React.createElement('div', { className: 'cpa-hint', key: 'h' }, t('loginHint')),
                React.createElement('a', {
                  className: 'cpa-loginlink',
                  key: 'a',
                  href: login.url,
                  target: '_blank',
                  rel: 'noreferrer noopener',
                }, login.url),
                React.createElement('div', { className: 'cpa-hint', key: 'w' }, t('loginWaiting')),
              ]
            : login.phase === 'error'
              ? [React.createElement('div', { className: 'cpa-hint', key: 'e' }, t('loginFailed') + '：' + login.error)]
              : [React.createElement('div', { className: 'cpa-hint', key: 'i' }, t('loginIntro'))];

        const actions = [
          React.createElement(Button, {
            key: 'cancel',
            variant: 'ghost',
            size: 'sm',
            onClick: () => void closeLogin(),
          }, t('cancel')),
        ];
        if (login.phase === 'idle' || login.phase === 'error') {
          actions.push(
            React.createElement(Button, {
              key: 'go',
              variant: 'primary',
              size: 'sm',
              onClick: () => void startLogin(),
            }, t('startLogin')),
          );
        }

        children.push(
          React.createElement(
            'div',
            { className: 'cpa-overlay', key: 'login' },
            React.createElement(
              'div',
              { className: 'cpa-modal' },
              React.createElement('div', { className: 'cpa-modal-title' }, t('addAccount') + ' · ' + meta.label),
              ...body,
              React.createElement('div', { className: 'cpa-modal-actions' }, ...actions),
            ),
          ),
        );
      }

      return React.createElement(React.Fragment, null, ...children);
    }

    /**
     * 账号使用顺序：**大卡片 + 拖拽排序**（像手机桌面拖图标）。
     *
     * 设计要点：
     *  - 每张卡是**独立方块**，有厚度（内边距、圆角、阴影），一眼看出"一叠卡片"；
     *  - 拖动时被拖的卡**浮起来**（放大 + 强阴影 + 倾斜），其他卡**滑开让位**；
     *  - 卡片上直接显示余额，不用回头看上面的账号卡就知道拖的是谁、还剩多少；
     *  - 序号用"第 N 位"表达而不是裸数字，`↑↓` 弱化为角落小按钮（键盘/触屏备用）。
     *
     * 为什么不再给"轮换"按钮：
     *  - `fill-first` 才是这里要的语义 —— 一个账号用满/不可用才切下一个；
     *  - `round-robin` 每个请求换凭据，**上游 Prompt/KV 缓存几乎不命中**，
     *    纯属浪费积分，对这个场景没有意义；
     *  - 摆一个会被误点的按钮，比不摆更糟。
     *
     * 当前策略仍**只读**显示，但不可改。
     */
    function RoutingSection(props) {
      const t = props.t;
      const plugin = props.plugin;
      /** 账号余额等，用来把卡片画丰满；由父级传入。 */
      const accounts = Array.isArray(props.accounts) ? props.accounts : [];
      const activeAuthId = props.activeAuthId ?? null;
      const [strategy, setStrategy] = React.useState(null);
      const [order, setOrder] = React.useState([]);
      const [busy, setBusy] = React.useState(false);
      const [note, setNote] = React.useState(null);
      /** 拖拽中的行下标；null 表示没有在拖。 */
      const [dragIndex, setDragIndex] = React.useState(null);
      /** 拖到哪一行上方（用于高亮落点）。 */
      const [dragOverIndex, setDragOverIndex] = React.useState(null);

      const load = React.useCallback(async () => {
        const [routingResponse, priorityResponse] = await Promise.all([
          api('/api/v1/cpa/routing'),
          plugin === undefined
            ? Promise.resolve(undefined)
            : api('/api/v1/cpa/priority?plugin=' + encodeURIComponent(plugin)),
        ]);
        if (routingResponse?.ok === true) setStrategy(routingResponse.strategy);
        setOrder(priorityResponse?.ok === true ? (priorityResponse.items ?? []) : []);
      }, [plugin]);

      React.useEffect(() => {
        void load();
      }, [load]);

      const move = (index, delta) => {
        const next = [...order];
        const target = index + delta;
        if (target < 0 || target >= next.length) return;
        const tmp = next[index];
        next[index] = next[target];
        next[target] = tmp;
        setOrder(next);
      };

      const saveOrder = async () => {
        setBusy(true);
        try {
          const result = await api('/api/v1/cpa/priority?plugin=' + encodeURIComponent(plugin), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ order: order.map((item) => item.nickname) }),
          });
          if (result?.ok === true) {
            setNote(t('prioritySaved'));
            await load();
          } else {
            setNote(String(result?.error ?? 'failed'));
          }
        } finally {
          setBusy(false);
        }
      };

      /**
       * 造一张可拖动的账号卡。
       *
       * 抽成函数而不是内联在 map 里：内联时括号嵌套极深，改一次就要重数一遍
       * （已经数错过一次，`React.createElement` 的闭合漏了一个）。
       *
       * @param item - 顺序表里的一项（`file` 是 auth 文件名，即 `authId`）。
       * @param index - 当前位次，0 是首选。
       */
      const buildCard = (item, index) => {
        const account = accounts.find((a) => a.authId === item.file);
        const credits = account?.credits;
        const isActive = activeAuthId !== null && item.file === activeAuthId;

        return React.createElement(
          'div',
          {
            key: item.file,
            className:
              'cpa-prow' +
              (dragIndex === index ? ' dragging' : '') +
              (dragIndex !== null && dragIndex !== index ? ' shifted' : ''),
            draggable: !busy,
            onDragStart: (event) => {
              setDragIndex(index);
              setDragOverIndex(index);
              // 某些浏览器不设 dataTransfer 就不触发拖拽
              try {
                event.dataTransfer.setData('text/plain', String(index));
                event.dataTransfer.effectAllowed = 'move';
              } catch {
                /* 忽略 */
              }
            },
            onDragOver: (event) => {
              event.preventDefault();
              try {
                event.dataTransfer.dropEffect = 'move';
              } catch {
                /* 忽略 */
              }
              /**
               * **实时重排**：鼠标每压到一张卡，就把被拖的卡挪到那个位置。
               *
               * 其他卡当场让位（配合 CSS transition 就是滑动效果），
               * 而不是等松手才跳 —— 后者看不出"会落到哪"。
               */
              if (dragOverIndex === null || dragOverIndex === index) return;
              const from = dragOverIndex;
              setDragOverIndex(index);
              setOrder((prev) => {
                const next = [...prev];
                const [moved] = next.splice(from, 1);
                next.splice(index, 0, moved);
                return next;
              });
              // 被拖的卡现在落到 index 了，同步它的新下标
              setDragIndex(index);
            },
            onDrop: (event) => {
              event.preventDefault();
              setDragIndex(null);
              setDragOverIndex(null);
            },
            onDragEnd: () => {
              setDragIndex(null);
              setDragOverIndex(null);
            },
          },
          // 位次徽标：第 1 位用主色实心，其余描边
          React.createElement(
            'div',
            { className: 'cpa-card-rank' + (index === 0 ? ' first' : '') },
            index === 0 ? t('rankFirst') : '#' + String(index + 1),
          ),
          React.createElement(
            'div',
            { className: 'cpa-card-body' },
            React.createElement(
              'div',
              { className: 'cpa-card-name-row' },
              React.createElement('span', { className: 'cpa-card-name' }, item.nickname),
              isActive ? React.createElement(Tag, { tone: 'solid' }, t('inUse')) : null,
            ),
            React.createElement(
              'div',
              { className: 'cpa-card-sub' },
              credits === undefined || credits === null
                ? t('noCredits')
                : t('remain') +
                    ' ' +
                    fmt(credits.remain) +
                    (credits.packCount > 0 ? ' · ' + String(credits.packCount) + ' ' + t('packs') : ''),
            ),
          ),
          // 拖拽把手（视觉锚点）
          React.createElement('span', { className: 'cpa-grip', title: t('dragHint') }, '⠿'),
          // ↑↓ 弱化到角落，给触屏和键盘用
          React.createElement(
            'div',
            { className: 'cpa-card-moves' },
            React.createElement(
              Button,
              {
                variant: 'ghost',
                size: 'sm',
                disabled: busy || index === 0,
                onClick: () => move(index, -1),
                title: t('moveUp'),
                'aria-label': t('moveUp'),
                className: 'cpa-move',
              },
              '↑',
            ),
            React.createElement(
              Button,
              {
                variant: 'ghost',
                size: 'sm',
                disabled: busy || index === order.length - 1,
                onClick: () => move(index, 1),
                title: t('moveDown'),
                'aria-label': t('moveDown'),
                className: 'cpa-move',
              },
              '↓',
            ),
          ),
        );
      };

      return React.createElement(
        'div',
        { className: 'cpa-section' },
        React.createElement('div', { className: 'cpa-section-title' }, t('routing')),
        React.createElement('div', { className: 'cpa-hint' }, t('routingHint')),
        // 只读展示当前策略；`round-robin` 会在下面给出警告（它会让缓存几乎不命中）
        strategy === null
          ? null
          : React.createElement(
              'div',
              { className: 'cpa-hint' },
              t('strategyLabel') +
                '：' +
                (strategy === 'fill-first'
                  ? t('strategyFillFirst')
                  : strategy === 'round-robin'
                    ? t('strategyRoundRobin') + ' ⚠️ ' + t('strategyWarn')
                    : String(strategy)),
            ),
        /**
         * 顺序卡片。
         *
         * ⚠️ **只有卡片能进 `.cpa-priority`（那是 grid）**：
         * 提示文字和保存按钮曾经也被塞进去，结果它们各自占一个网格单元，
         * 按钮就浮在卡片中间了。现在提示在外、卡片在 grid、按钮在下面。
         */
        /**
         * 顺序卡片。
         *
         * ⚠️ **只有卡片能进 `.cpa-priority`（那是 grid）**：
         * 提示文字和保存按钮曾经也被塞进去，结果它们各自占一个网格单元，
         * 按钮就浮在卡片中间了。现在：提示在外、卡片在 grid、按钮在下面。
         */
        order.length > 0
          ? React.createElement(
              React.Fragment,
              null,
              // 拖拽说明：单独一行，不进 grid
              React.createElement('div', { className: 'cpa-hint' }, t('dragToReorder')),
              // 卡片网格
              React.createElement(
                'div',
                { className: 'cpa-priority' },
                ...order.map((item, index) => buildCard(item, index)),
              ),
              // 保存：在 grid 之外，否则会被当成一个网格单元
              React.createElement(
                'div',
                { className: 'cpa-save-row' },
                React.createElement(
                  Button,
                  {
                    variant: 'primary',
                    size: 'md',
                    disabled: busy,
                    onClick: () => void saveOrder(),
                  },
                  busy ? t('saving') : t('save'),
                ),
              ),
            )
          : React.createElement('div', { className: 'cpa-hint' }, t('priorityNone')),
        note === null ? null : React.createElement('div', { className: 'cpa-hint' }, note),
      );
    }

    /** 顶层：状态条 + 插件标签。 */
    function Panel(props) {
      const t = props.t;
      const [status, setStatus] = React.useState(null);
      const [plugins, setPlugins] = React.useState([]);
      const [active, setActive] = React.useState('workbuddy');
      /**
       * 当前插件面板上报的账号数据，供下面的"账号使用顺序"卡片复用。
       *
       * 为什么不各拉一次：两边都要 `accounts`，各打一次接口既慢又可能不一致
       * （余额是实时算的，两次结果未必相同）。由 PluginPanel 拉一次、上报上来。
       */
      const [pluginState, setPluginState] = React.useState({ accounts: [], activeAuthId: null });

      React.useEffect(() => {
        void (async () => {
          const [statusResponse, pluginsResponse] = await Promise.all([
            api('/api/v1/cpa/status'),
            api('/api/v1/cpa/plugins'),
          ]);
          setStatus(statusResponse);
          const list = Array.isArray(pluginsResponse?.plugins) ? pluginsResponse.plugins : [];
          setPlugins(list);
          if (list.length > 0 && !list.some((p) => p.id === 'workbuddy')) {
            setActive(list[0].id);
          }
        })();
      }, []);

      const start = async () => {
        const result = await api('/api/v1/cpa/start', { method: 'POST' });
        setStatus((prev) => ({ ...(prev ?? {}), running: result?.ok === true }));
      };

      const activeMeta = plugins.find((p) => p.id === active);

      return React.createElement(
        'div',
        { className: 'cpa-wrap' },
        status !== null
          ? React.createElement('div', { className: 'cpa-status' },
              // 官方状态点：done=绿、error=红，语义比自绘圆点更准
              React.createElement(StateDot, { state: status.running ? 'done' : 'error' }),
              React.createElement('span', null,
                (status.running ? t('running') : t('stopped')) + ' · 127.0.0.1:' + String(status.port)),
              status.running ? null : React.createElement(Button, {
                variant: 'outline', size: 'sm', onClick: () => void start(),
              }, t('start')),
              status.hasAdminKey ? null : React.createElement(Tag, { tone: 'warning' }, t('noAdminKey')),
              /**
               * CPA 自带管理控制台的入口。
               *
               * 本插件启动 CPA 时带了 `-no-browser`（否则每次拉起都会自动弹浏览器），
               * 所以控制台不再自己冒出来 —— 需要时从这里点开。
               * 只在 CPA 运行时才渲染：没跑的时候点开是死链。
               */
              status.running
                ? React.createElement('a', {
                    className: 'cpa-link',
                    href: 'http://127.0.0.1:' + String(status.port) + '/management.html',
                    target: '_blank',
                    rel: 'noreferrer noopener',
                    title: t('consoleHint'),
                  }, t('console'))
                : null,
            )
          : null,
        React.createElement('div', { className: 'cpa-tabs' },
          ...plugins.map((plugin) =>
            // Pill 自带 active 视觉（选中态），比自绘下划线省事且一致
            React.createElement(Pill, {
              key: plugin.id,
              active: plugin.id === active,
              onClick: () => setActive(plugin.id),
            }, plugin.label),
          ),
        ),
        activeMeta === undefined
          ? React.createElement('div', { className: 'cpa-empty' }, t('loading'))
          : React.createElement(PluginPanel, {
              key: activeMeta.id,
              plugin: activeMeta.id,
              meta: activeMeta,
              t,
              // 上报账号数据给父级（供顺序卡片显示余额）
              onAccounts: setPluginState,
            }),
        // 账号顺序区：跟随当前插件（每个插件有各自的账号池）
        activeMeta === undefined
          ? null
          : React.createElement(RoutingSection, {
              key: 'routing-' + activeMeta.id,
              t,
              plugin: activeMeta.id,
              label: activeMeta.label,
              // 把账号数据传下去，卡片上直接显示余额
              accounts: pluginState.accounts,
              activeAuthId: pluginState.activeAuthId,
            }),
      );
    }

    /**
     * 只保留官方组件**不负责**的布局样式。
     *
     * 已经交给 primitives 的（按钮、开关、标签、状态点、分段标签）不再自己写 —— 
     * 自绘会和主题 token 脱节，明暗切换、焦点环、禁用态都得重做一遍。
     */
    const CSS = [
      '.cpa-wrap{font-size:13px;line-height:1.6;display:flex;flex-direction:column;gap:12px}',
      '.cpa-status{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-tertiary)}',
      '.cpa-link{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-secondary);text-decoration:none;border-bottom:1px dashed currentColor}',
      '.cpa-link:hover{color:var(--dsw-alias-label-primary)}',
      '.cpa-tabs{display:flex;gap:6px;flex-wrap:wrap}',
      '.cpa-sum{display:flex;gap:10px;flex-wrap:wrap}',
      '.cpa-sumc{flex:1;min-width:130px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:2px}',
      '.cpa-sumv{font-size:19px;font-weight:600}',
      '.cpa-unit{font-size:13px;font-weight:400;color:var(--dsw-alias-label-tertiary)}',
      '.cpa-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.cpa-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}',
      // 「+ 添加账号」卡片：虚线边框、居中等，和被禁用的账号卡区分开
      '.cpa-addcard{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:86px;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;cursor:pointer;transition:border-color .16s ease,color .16s ease}',
      '.cpa-addcard:hover{border-color:var(--dsw-alias-label-secondary);color:var(--dsw-alias-label-primary)}',
      '.cpa-addplus{font-size:22px;line-height:1}',
      '.cpa-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:1000}',
      '.cpa-modal{background:var(--dsw-alias-bg-base,#1c1c1e);border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;padding:18px;max-width:520px;width:calc(100% - 48px);display:flex;flex-direction:column;gap:10px;box-shadow:0 16px 40px rgba(0,0,0,.4)}',
      '.cpa-modal-title{font-size:14px;font-weight:600}',
      '.cpa-modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:4px}',
      '.cpa-loginlink{font-size:11px;word-break:break-all;color:var(--dsw-alias-label-secondary)}',
      '.cpa-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px}',
      '.cpa-card.sel{border-color:#2ea043}',
      '.cpa-card-head{display:flex;align-items:center;gap:6px;margin-bottom:10px;flex-wrap:wrap}',
      '.cpa-nick{font-weight:600;font-size:14px}',
      '.cpa-nums{display:flex;gap:16px;margin-bottom:8px}',
      '.cpa-num{display:flex;flex-direction:column}',
      '.cpa-lbl{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.cpa-val{font-size:16px;font-weight:600}',
      '.cpa-bar{height:4px;border-radius:2px;background:var(--dsw-alias-border-l2);overflow:hidden;margin-bottom:10px}',
      '.cpa-fill{height:100%;background:#2ea043}',
      '.cpa-meta{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-bottom:8px}',
      '.cpa-actions{display:flex;gap:6px;flex-wrap:wrap}',
      '.cpa-switch{margin-left:auto;display:flex;align-items:center;gap:8px;cursor:pointer}',
      '.cpa-switch-text{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.cpa-active-note{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5;margin-top:-4px}',
      '.cpa-empty{padding:24px;text-align:center;color:var(--dsw-alias-label-tertiary)}',
      '.cpa-muted{color:var(--dsw-alias-label-tertiary)}',
      '.cpa-toast{padding:8px 12px;border-radius:6px;font-size:12px;border:.5px solid}',
      '.cpa-toast.ok{color:#2ea043;border-color:#2ea043}',
      '.cpa-toast.err{color:#d1242f;border-color:#d1242f}',
      '.cpa-section{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:14px;display:flex;flex-direction:column;gap:8px}',
      '.cpa-section-title{font-size:14px;font-weight:600}',
      '.cpa-hint{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5}',
      '.cpa-priority{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px;margin-top:6px}',
      /**
       * 卡片：像手机桌面的一块图标。
       *  - 最小高度撑出"方块"感，不是细长条；
       *  - 常驻浅阴影，看着有厚度（"一叠"的观感来源）；
       *  - `transition` 让让位是滑过去的。
       */
      '.cpa-prow{position:relative;display:flex;align-items:flex-start;gap:10px;min-height:86px;padding:12px 12px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-base,rgba(128,128,128,.04));cursor:grab;box-shadow:0 1px 2px rgba(0,0,0,.10);transition:transform .18s cubic-bezier(.2,.8,.3,1),box-shadow .18s ease,border-color .18s ease,opacity .18s ease}',
      '.cpa-prow:hover{border-color:var(--dsw-alias-label-tertiary);box-shadow:0 3px 10px rgba(0,0,0,.16)}',
      /**
       * 被拖的卡片：**浮起来**。
       * 放大 + 强阴影 + 轻微倾斜 + 绿色描边，四个信号叠加，
       * 一眼看出"这张被拎在手里"，而不是只变个透明度。
       */
      '.cpa-prow.dragging{opacity:.92;cursor:grabbing;transform:scale(1.04) rotate(-1.2deg);border-color:#2ea043;box-shadow:0 12px 28px rgba(0,0,0,.34);z-index:2}',
      // 其他卡片在被拖时轻微降透明度，突出被拖的那张
      '.cpa-prow.shifted{opacity:.72}',
      // 位次徽标：第 1 位用主色实心，其余描边
      '.cpa-card-rank{flex:none;min-width:30px;height:24px;padding:0 7px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary)}',
      '.cpa-card-rank.first{background:#2ea043;border-color:#2ea043;color:#fff}',
      '.cpa-card-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:5px}',
      '.cpa-card-name-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.cpa-card-name{font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cpa-card-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.cpa-grip{position:absolute;right:10px;top:9px;color:var(--dsw-alias-label-tertiary);font-size:15px;line-height:1;letter-spacing:-1px;user-select:none;opacity:.5}',
      '.cpa-prow:hover .cpa-grip{opacity:1}',
      '.cpa-card-moves{position:absolute;right:8px;bottom:6px;display:flex;gap:2px}',
      '.cpa-move{width:20px!important;min-width:20px!important;height:20px!important;padding:0!important;font-size:11px!important;line-height:1!important}',
      '.cpa-save-row{display:flex;justify-content:flex-end;margin-top:4px}',
    ].join('');

    function injectCss() {
      if (typeof document === 'undefined') return;
      if (document.querySelector('style[data-plugin-css="dsh-cpa-panel"]') !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-cpa-panel';
      tag.dataset.pluginCss = 'dsh-cpa-panel';
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    function apply(ctx) {
      injectCss();
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'cpa-panel: dictionaries');
      const t = ctx.locale.bind(NS);

      /**
       * 判断当前详情页是不是本插件自己的。
       *
       * ⚠️ `subject.pkg` **不是字符串**，而是 `packageRef(pkg)` 的返回：
       * `{ name, version, installed, enabled, rows }` —— 所以要读 `.name`，
       * 直接和包名字符串比较会永远为 false（内容就永远不渲染）。
       */
      const isMine = (subject) => {
        if (subject === undefined || subject === null) return false;
        if (subject.kind !== 'bundle' && subject.kind !== 'row') return false;
        const name = subject.pkg?.name ?? subject.pkg;
        return name === PKG_NAME;
      };

      ctx.slots.inject('plugins.detail.section', () =>
        ctx.slots.register(
          {
            name: 'plugins.detail.section',
            id: TAB_ID,
            order: 20,
            locale: NS,
          },
          (seat) => {
            if (!isMine(seat?.subject)) return null;
            return React.createElement(Panel, {
              t: typeof seat?.t === 'function' ? seat.t : t,
            });
          },
        ),
      );

      // 保留设置页标签作为次要入口（有些部署只在设置里翻插件）。
      ctx.slots.inject('settings.plugins.tab', () =>
        ctx.slots.register(
          {
            name: 'settings.plugins.tab',
            id: TAB_ID,
            order: 20,
            label: () => t('tab'),
            locale: NS,
          },
          (seat) =>
            React.createElement(Panel, { t: typeof seat?.t === 'function' ? seat.t : t }),
        ),
      );
    }

    exports.apply = apply;
    exports.inject = ['slots', 'locale'];
    return module.exports;
  },
});
