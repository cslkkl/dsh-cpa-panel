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
      disabled: '已禁用',
      select: '选择',
      selected: '已选择',
      selectHint: '选中这个账号，同渠道其余账号会自动全部禁用',
      selectedHint: '当前就是这个账号在服务',
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
      streak: '连签',
      days: '天',
      packs: '包',
      unitCredits: '积分',
      unitTokens: 'token',
      models: '模型',
      modelCount: '个模型',
      unitMixed: '（不同插件单位不同，未合并）',
      routing: '调度',
      strategyLabel: '当前策略',
      strategyFillFirst: '用满再用下一个',
      strategyRoundRobin: '轮换',
      strategyWarn: '每个请求换号，缓存几乎不命中，会明显多花积分',
      priority: '账号优先级',
      rankFirst: '首选',
      noCredits: '余额未知',
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
      disabled: 'Disabled',
      select: 'Select',
      selected: 'Selected',
      selectHint: 'Use this account and automatically disable the others in this channel',
      selectedHint: 'This account is currently serving',
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
      streak: 'Streak',
      days: 'd',
      packs: 'packs',
      unitCredits: 'credits',
      unitTokens: 'tokens',
      models: 'Models',
      modelCount: ' models',
      unitMixed: '(units differ per plugin; not merged)',
      routing: 'Routing',
      strategyLabel: 'Current strategy',
      strategyFillFirst: 'Fill first',
      strategyRoundRobin: 'Round robin',
      strategyWarn: 'switches credentials per request; the cache almost never hits, costing noticeably more',
      priority: 'Account priority',
      rankFirst: 'First',
      noCredits: 'Balance unknown',
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
     * 「选择」账号：启用它，并自动禁用**同一渠道**的其余账号。
     *
     * 一次调用把整个渠道收敛到单账号 —— 用户不必逐个点禁用。
     */
    function selectCpaAccount(plugin, authIndex) {
      return api('/api/v1/cpa/account-select', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plugin, authIndex }),
      });
    }

    /**
     * 启用 / 禁用账号（单个切换）。
     *
     * 面板上已不直接用这个 —— 改成「选择」一步到位。保留它是为了
     * 将来可能需要"只禁用某一个、其余不动"的场景。
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
      /**
       * 高亮 = **用户选中的这个号**，不做"实际在跑哪个号"的推断。
       *
       * 判定就是 `!disabled`：因为「选择」的语义是同渠道只留一个启用，
       * 所以启用状态**就等于**用户的选择。比原来按请求统计推断可靠得多
       * （限流、缓存命中都会让统计失真）。
       */
      const isSelected = account.disabled !== true;
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

      /**
       * 「选择」这个账号。
       *
       * 语义：**选中它，同渠道其余账号全部自动禁用** ——
       * 一次点击把整个渠道收敛到单账号，不用逐个点禁用。
       * 见 host 的 `accountSelect`。
       */
      const selectAccount = async () => {
        setBusy('select');
        try {
          const result = await selectCpaAccount(props.plugin, account.authIndex);
          props.onToast(
            t('select') + (result?.ok === true ? ' ✓' : ' ✗'),
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
       * 徽标只反映**用户自己的选择**，不做"实际在用哪个号"的推断。
       *
       * 曾经这里有个「使用中」标签，按 `recent_requests` 统计标出实际
       * 被调度的账号。用户明确不要它 —— "用哪个我自己会决定"。
       * 而且那个推断本身也不可靠（被限流 / 缓存命中都会让统计失真）。
       */
      // Tag 的 tone 语义：solid=当前选中项、danger=已禁用、outline=只读事实
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
       * 「选择」—— 选中它，同渠道其余账号**自动全部禁用**。
       *
       * 这是"只有一个账号消耗积分"的唯一手段，也是用户要的交互：
       * 点一下就把整个渠道收敛到这一个号，不用逐个点禁用。
       *
       * 为什么不能只靠 `priority`：
       *  - `priority` 只是"尽量先用高的"，高的不可用时会**降级**到别人；
       *  - `fill-first` 取"第一个可用凭据"，首选号瞬时冷却就切走；
       *  - 只有**禁用**是"根本不参与"，没有降级空间。
       *
       * 代价（刻意）：该渠道唯一的号不可用时请求直接失败，**没有兜底** ——
       * 宁可失败，也不要偷偷换号把上游缓存打散、把积分花在别的号上。
       */
      actions.push(React.createElement(Button, {
        key: 'select',
        variant: account.disabled ? 'primary' : 'ghost',
        size: 'sm',
        disabled: busy !== '' || !account.disabled,
        title: account.disabled ? t('selectHint') : t('selectedHint'),
        onClick: () => void selectAccount(),
      }, account.disabled ? t('select') : t('selected')));

      const meta = [];
      if (credits !== null && credits.packCount > 0) {
        meta.push(String(credits.packCount) + ' ' + t('packs'));
      }
      if (credits?.plan !== undefined) meta.push(String(credits.plan));
      if (credits?.remainKnown === false) meta.push(t('remain') + ' ?');

      return React.createElement(
        'div',
        { className: 'cpa-card' + (isSelected ? ' sel' : '') },
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
          remain,
          used,
          size,
        });
        // 上报给父级，供「调度」区展示（避免再拉一次接口）
        props.onAccounts?.({ accounts });
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
    /**
     * 路由状态（只读）。
     *
     * **这里不再有「账号使用顺序」的拖动排序。**
     *
     * 为什么删掉：用户控制用哪个账号已经有两个更直接的手段 ——
     *  1. 账号卡上的「启用 / 禁用」：禁用 = 根本不参与调度，没有降级空间；
     *  2. 插件会记住用户的选择并在启动时恢复。
     * 而 `priority` 只是"尽量先用高的"，首选号不可用时会降级到别人 ——
     * 它既不如禁用可靠，又要用户多维护一份顺序。留着只会误导。
     *
     * 保留的部分：**只读展示当前路由策略**。`round-robin` 会让上游
     * Prompt/KV 缓存几乎不命中（实测 4% vs `fill-first` 的 75%），
     * 万一被改掉，这行是唯一的提示。
     */
    function RoutingSection(props) {
      const t = props.t;
      const [strategy, setStrategy] = React.useState(null);

      const load = React.useCallback(async () => {
        const routingResponse = await api('/api/v1/cpa/routing');
        if (routingResponse?.ok === true) setStrategy(routingResponse.strategy);
      }, []);

      React.useEffect(() => {
        void load();
      }, [load]);

      if (strategy === null) return null;

      return React.createElement(
        'div',
        { className: 'cpa-section' },
        React.createElement('div', { className: 'cpa-section-title' }, t('routing')),
        React.createElement(
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
      );
    }

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
      const [pluginState, setPluginState] = React.useState({ accounts: [] });

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
      '.cpa-empty{padding:24px;text-align:center;color:var(--dsw-alias-label-tertiary)}',
      '.cpa-muted{color:var(--dsw-alias-label-tertiary)}',
      '.cpa-toast{padding:8px 12px;border-radius:6px;font-size:12px;border:.5px solid}',
      '.cpa-toast.ok{color:#2ea043;border-color:#2ea043}',
      '.cpa-toast.err{color:#d1242f;border-color:#d1242f}',
      '.cpa-section{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:14px;display:flex;flex-direction:column;gap:8px}',
      '.cpa-section-title{font-size:14px;font-weight:600}',
      '.cpa-hint{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5}',
      /**
       * 卡片：像手机桌面的一块图标。
       *  - 最小高度撑出"方块"感，不是细长条；
       *  - 常驻浅阴影，看着有厚度（"一叠"的观感来源）；
       *  - `transition` 让让位是滑过去的。
       */
      /**
       * 被拖的卡片：**浮起来**。
       * 放大 + 强阴影 + 轻微倾斜 + 绿色描边，四个信号叠加，
       * 一眼看出"这张被拎在手里"，而不是只变个透明度。
       */
      // 其他卡片在被拖时轻微降透明度，突出被拖的那张
      // 位次徽标：第 1 位用主色实心，其余描边
      '.cpa-card-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:5px}',
      '.cpa-card-name-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.cpa-card-name{font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cpa-card-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
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
