import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { ActivityMode, AnswerDraft, AttemptResult, BootstrapData, CoachMessage, PlanTask, PublicActivity, Section } from "./shared/domain.js";
import { api, ApiError, setUnauthorizedHandler } from "./services/api.js";
import { Icon, type IconName } from "./components/Icon.js";
import { LoginView } from "./components/LoginView.js";
import { ExamPreparation, type Preparation } from "./components/ExamPreparation.js";

type Page = "home" | "listening" | "reading" | "mock" | "review" | "profile" | "settings" | "workspace" | "preparation";
type Session = { activity: PublicActivity; draft: AnswerDraft; result?: AttemptResult };
type CoachLine = { role: "user" | "assistant"; text: string; id: string };
const navItems: Array<{ page: Page; label: string; icon: IconName }> = [
  { page: "home", label: "今日学习", icon: "home" }, { page: "listening", label: "听力练习", icon: "headphones" },
  { page: "reading", label: "阅读练习", icon: "book" }, { page: "mock", label: "完整模考", icon: "file" },
  { page: "review", label: "错题复习", icon: "repeat" }, { page: "profile", label: "学习画像", icon: "chart" },
  { page: "settings", label: "设置", icon: "settings" },
];
const sectionLabel: Record<Section, string> = { listening: "听力", reading: "阅读", vocabulary: "词汇" };
const difficultyLabel: Record<1 | 2 | 3, string> = { 1: "基础", 2: "进阶", 3: "挑战" };
const partLabel: Record<"reading" | "listening", Record<number, string>> = {
  listening: { 1: "Part 1", 2: "Part 2", 3: "Part 3", 4: "Part 4" },
  reading: { 1: "Passage 1", 2: "Passage 2", 3: "Passage 3" },
};
const partOptions = (section: "reading" | "listening") => section === "reading" ? [1, 2, 3] as const : [1, 2, 3, 4] as const;
const coachKey = (id: string) => "coach-" + id;
const railHiddenKey = "ielts-rail-hidden";
const errorMessage = (value: unknown) => value instanceof Error ? value.message : "刚才没有完成，请重试。";
const percent = (value: number, total: number) => total ? Math.round(value / total * 100) : 0;
const monthDay = (date: string) => new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(new Date(date + "T12:00:00"));

export function App() {
  const [page, setPage] = useState<Page>("home");
  const [workspaceReturnPage, setWorkspaceReturnPage] = useState<Page>("home");
  const [data, setData] = useState<BootstrapData>();
  const [session, setSession] = useState<Session>();
  const [preparation, setPreparation] = useState<Preparation>();
  const [coachOpen, setCoachOpen] = useState(false);
  const [railHidden, setRailHidden] = useState(() => localStorage.getItem(railHiddenKey) === "1");
  const [coachLines, setCoachLines] = useState<CoachLine[]>([]);
  const [coachLoading, setCoachLoading] = useState(false);
  const [coachError, setCoachError] = useState("");
  const [failedMessage, setFailedMessage] = useState("");
  const [questionId, setQuestionId] = useState("");
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [bootToken, setBootToken] = useState(0);
  const loaded = useRef(false);
  const performing = useRef(false);

  const refresh = useCallback(async () => {
    const value = await api.bootstrap();
    setData(value);
    return value;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api.authSession().then((sessionState) => {
      if (cancelled) return;
      setAuthenticated(sessionState.authenticated);
      setAuthReady(true);
    }).catch((reason) => { if (!cancelled) { setError(errorMessage(reason)); setAuthReady(true); } });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      void api.authSession().then((state) => {
        if (state.authenticated) return;
        loaded.current = false;
        setAuthenticated(false);
        setData(undefined);
        setSession(undefined);
        setCoachOpen(false);
        setCoachLines([]);
        setCoachError("");
        setFailedMessage("");
        setError("");
        setToast("");
      }).catch(() => undefined);
    });
    return () => setUnauthorizedHandler(undefined);
  }, []);

  useEffect(() => {
    if (!authReady || !authenticated || loaded.current) return;
    let cancelled = false;
    void (async () => {
      try {
        const boot = await api.bootstrap();
        if (cancelled) return;
        setData(boot);
        const saved = localStorage.getItem("ielts-active-attempt");
        if (saved) {
          try {
            const resumed = await api.resumeAttempt(saved);
            if (cancelled) return;
            if (!resumed.activity || (!resumed.draft && !resumed.result)) {
              localStorage.removeItem("ielts-active-attempt");
            } else {
              const result = resumed.result;
              const draft = resumed.draft ?? {
                attemptId: saved, activityId: resumed.activity.id, mode: result!.mode, answers: result!.answers,
                saveRevision: result!.saveRevision ?? 0, hintedQuestionIds: result!.hintedQuestionIds, startedAt: result!.startedAt, updatedAt: result!.updatedAt,
              };
              setSession({ activity: resumed.activity, draft, result });
              setQuestionId(resumed.activity.questions[0]?.id ?? "");
              setPage("workspace");
            }
          } catch (reason) {
            if (cancelled) return;
            if (reason instanceof ApiError && (reason.status === 404 || reason.status === 410)) localStorage.removeItem("ielts-active-attempt");
            else if (reason instanceof ApiError && reason.status === 401) return;
            else setError("练习草稿暂时无法恢复：" + errorMessage(reason));
          }
        }
        if (!cancelled) loaded.current = true;
      } catch (reason) { if (!cancelled) setError(errorMessage(reason)); }
    })();
    return () => { cancelled = true; };
  }, [authReady, authenticated, bootToken]);

  useEffect(() => {
    if (!data || data.planProposal.status !== "generating") return;
    let active = true;
    const timer = window.setInterval(() => {
      void api.planProposalStatus().then(({ proposal }) => {
        if (active && (proposal.id !== data.planProposal.id || proposal.status !== "generating")) void refresh().catch((reason) => setError(errorMessage(reason)));
      }).catch((reason) => { if (active) setError(errorMessage(reason)); });
    }, 2500);
    return () => { active = false; window.clearInterval(timer); };
  }, [data, refresh]);

  const login = useCallback(async (password: string) => { await api.login(password); setAuthenticated(true); }, []);
  const logout = useCallback(async () => {
    await api.logout();
    setAuthenticated(false); setData(undefined); setSession(undefined);
    setCoachOpen(false); setCoachLines([]); setCoachError(""); setFailedMessage(""); setError(""); setToast("");
    loaded.current = false;
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const perform = useCallback(async <T,>(action: () => Promise<T>, done?: (value: T) => void) => {
    if (performing.current) return undefined;
    performing.current = true;
    setBusy(true);
    setError("");
    try { const value = await action(); done?.(value); return value; }
    catch (reason) { setError(errorMessage(reason)); return undefined; }
    finally { performing.current = false; setBusy(false); }
  }, []);

  const startActivity = useCallback(async (id: string, mode: ActivityMode = "practice", taskId?: string, reviewIds?: string[], questionIds?: string[]) => {
    const activity = data?.activities.find((item) => item.id === id);
    if (!activity) { setError("找不到练习材料，请刷新题库后重试。"); return; }
    setWorkspaceReturnPage(page === "workspace" ? "home" : page);
    setToast(""); setPreparation({ activity, mode, taskId, reviewIds, questionIds });
    setCoachOpen(false); setPage("preparation");
  }, [data, page]);

  const startMock = useCallback(async (section: "reading" | "listening") => {
    const value = await perform(() => api.prepareMock(section));
    if (!value) return;
    setWorkspaceReturnPage(page === "workspace" ? "mock" : page);
    setToast(""); setPreparation({ activity: value.activity, mode: "mock" });
    setCoachOpen(false); setPage("preparation");
  }, [page, perform]);

  const launchPreparation = useCallback(async (durations: number[]) => {
    if (!preparation) return false;
    const { activity, mode, taskId, reviewIds, questionIds } = preparation;
    const value = await perform(() => mode === "mock"
      ? api.startMock(activity.pluginId as "reading" | "listening", activity.mockId!, durations)
      : api.startAttempt(activity.id, mode, taskId, reviewIds, questionIds));
    if (!value) return false;
    localStorage.setItem("ielts-active-attempt", value.draft.attemptId);
    setSession({ activity: value.activity, draft: value.draft });
    setQuestionId(value.activity.questions[0]?.id ?? "");
    setCoachOpen(false); setCoachLines([]); setPreparation(undefined); setPage("workspace");
    return true;
  }, [preparation, perform]);

  const startTask = useCallback((task: PlanTask) => startActivity(task.activityId, task.kind === "review" ? "review" : "practice", task.id, task.reviewQuestionIds, task.questionIds), [startActivity]);

  const saveProfile = useCallback(async (profile: Omit<BootstrapData["profile"], "id" | "updatedAt">) => {
    const value = await perform(() => api.setProfile(profile), (updated) => {
      setData(updated);
      setToast("目标已保存。");
    });
    return Boolean(value);
  }, [perform]);

  const submit = useCallback(async (answers: Record<string, string>, questionTimeSeconds: Record<string, number>) => {
    if (!session) return false;
    const attemptId = session.draft.attemptId;
    setBusy(true); setError("");
    try {
      const result = (await api.submit(attemptId, answers, questionTimeSeconds)).result;
      localStorage.removeItem("ielts-active-attempt");
      setSession((current) => current ? { ...current, draft: { ...current.draft, answers, questionTimeSeconds }, result } : current);
      setCoachOpen(false); await refresh(); setToast("练习已保存：" + result.score + " / " + result.total + " 题答对。");
      return true;
    } catch (reason) { setError(errorMessage(reason)); return false; }
    finally { setBusy(false); }
  }, [refresh, session]);

  const confirmCause = useCallback(async (attemptId: string, qid: string, tag: string, cause: string) => {
    const value = await perform(() => api.confirmCause(attemptId, qid, tag, cause), (updated) => {
      setData(updated);
      setToast("错因已记下，明日计划会参考这条证据。");
    });
    return Boolean(value);
  }, [perform]);

  const openAttempt = useCallback(async (attemptId: string) => {
    const value = await perform(() => api.resumeAttempt(attemptId));
    if (!value?.result || !value.activity) return;
    setWorkspaceReturnPage("profile");
    setSession({ activity: value.activity, draft: value.result, result: value.result });
    setQuestionId(value.activity.questions[0]?.id ?? "");
    setToast(""); setCoachOpen(false); setCoachLines([]); setPage("workspace");
  }, [perform]);

  const confirmPlanProposal = useCallback(async (id: string) => {
    await perform(() => api.confirmPlanProposal(id), (updated) => {
      setData(updated);
      setToast(updated.planProposal.status === "failed" ? updated.planProposal.error ?? "锁定任务后方案需要重新规划。" : "已按 AI 建议更新未锁定任务。");
    });
  }, [perform]);

  const dismissPlanProposal = useCallback(async (id: string) => {
    await perform(() => api.dismissPlanProposal(id), (updated) => { setData(updated); setToast("已保留当前学习计划。"); });
  }, [perform]);

  const retryPlanProposal = useCallback(async () => {
    await perform(() => api.retryPlanProposal(), setData);
  }, [perform]);

  const loadHistory = useCallback(async () => {
    if (!session) return;
    setCoachLoading(true);
    try {
      const value = await api.coachHistory(coachKey(session.draft.attemptId));
      setCoachLines(value.messages.map((item: CoachMessage) => ({ id: item.id, role: item.role, text: item.text })));
      setCoachError(""); setFailedMessage("");
    } catch (reason) { setCoachError(errorMessage(reason)); }
    finally { setCoachLoading(false); }
  }, [session]);

  const sendCoach = useCallback(async (message: string) => {
    if (!session || !questionId || !data?.aiConfigured) return;
    setCoachLoading(true); setCoachError(""); setFailedMessage("");
    setCoachLines((current) => [...current, { id: crypto.randomUUID(), role: "user", text: message }]);
    try {
      const value = await api.askCoach(coachKey(session.draft.attemptId), session.activity.id, questionId, session.draft.attemptId, message);
      setCoachLines((current) => [...current, { id: value.message.id, role: "assistant", text: value.message.text }]);
    } catch (reason) { setCoachError(errorMessage(reason)); setFailedMessage(message); }
    finally { setCoachLoading(false); }
  }, [data?.aiConfigured, questionId, session]);

  const goHome = useCallback(() => {
    if (session?.result) localStorage.removeItem("ielts-active-attempt");
    setPage(workspaceReturnPage === "workspace" ? "home" : workspaceReturnPage); setCoachOpen(false);
    void refresh().catch((reason) => setError(errorMessage(reason)));
  }, [refresh, session, workspaceReturnPage]);

  const toggleRail = useCallback(() => {
    setRailHidden((hidden) => {
      if (hidden) localStorage.removeItem(railHiddenKey);
      else localStorage.setItem(railHiddenKey, "1");
      return !hidden;
    });
  }, []);

  if (!authReady) return <div className="loading-shell" aria-busy="true"><main className="skeleton-main"><span className="skeleton skeleton-heading" /><p className="loading-caption">正在检查访问权限…</p></main></div>;
  if (!authenticated) return <LoginView onLogin={login} />;
  if (!data) return <div className="loading-shell" aria-busy="true">
    <aside className="skeleton-rail" aria-hidden="true"><span className="skeleton skeleton-brand" />{Array.from({ length: 6 }, (_, index) => <span className="skeleton skeleton-nav" key={index} />)}</aside>
    <main className="skeleton-main" aria-hidden="true"><span className="skeleton skeleton-heading" /><span className="skeleton skeleton-sub" /><span className="skeleton skeleton-block" /><span className="skeleton skeleton-block" /><span className="skeleton skeleton-block" /></main>
    <p className="loading-caption" role="status">{error || "正在打开你的学习空间…"}</p>
    {error && <button className="button button-outline button-small" onClick={() => { setError(""); setBootToken((value) => value + 1); }}>重新加载</button>}
  </div>;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Taipei" });
  const todayTasks = data.plan.filter((task) => task.date === today && task.status !== "expired");
  const currentQuestion = session?.activity.questions.find((item) => item.id === questionId) ?? session?.activity.questions[0];

  return <div className={"app-frame" + (coachOpen ? " coach-open" : "") + (railHidden ? " rail-hidden" : "") + ((page === "workspace" && session) || page === "preparation" ? " exam-active" : "")}>
    <aside className="side-rail">
      <button className="rail-collapse" type="button" aria-label="收起侧边栏" title="收起侧边栏" onClick={toggleRail}><Icon name="caret" size={16} /></button>
      <div className="brand"><span className="brand-stamp"><Icon name="sparkle" size={18} /></span><span className="brand-name">暖学 IELTS</span></div>
      <nav className="nav-list" aria-label="主要导航">{navItems.slice(0, 5).map((item) => <NavButton key={item.page} item={item} active={page === item.page} onClick={() => { setPage(item.page); setCoachOpen(false); }} />)}</nav>
      <div className="nav-spacer" /><div className="nav-divider" />
      <nav className="nav-list" aria-label="学习记录与设置">{navItems.slice(5).map((item) => <NavButton key={item.page} item={item} active={page === item.page} onClick={() => { setPage(item.page); setCoachOpen(false); }} />)}</nav>
      <div className="local-note"><Icon name="lock" size={14} /><span>学习记录已保护</span></div>
    </aside>
    <main className="page-main" key={page}>
      {railHidden && <div className="rail-toolbar"><button className="rail-expand" type="button" aria-label="展开侧边栏" title="展开侧边栏" onClick={toggleRail}><Icon name="menu" size={18} /></button></div>}
      {page === "home" && <HomePage data={data} today={today} tasks={todayTasks} onPage={setPage} onTask={startTask} onActivity={(id) => void startActivity(id)} onLock={(task) => void perform(() => api.updatePlan(task.id, { locked: !task.locked }), setData)} onSetup={() => setPage("settings")} busy={busy} onConfirmProposal={confirmPlanProposal} onDismissProposal={dismissPlanProposal} onRetryProposal={retryPlanProposal} />}
      {(page === "reading" || page === "listening") && <LibraryPage section={page} data={data} onStart={(id) => void startActivity(id)} />}
      {page === "mock" && <MockPage data={data} onStart={(section) => void startMock(section)} busy={busy} />}
      {page === "review" && <ReviewPage data={data} onStart={(id, ids) => void startActivity(id, "review", undefined, ids)} />}
      {page === "profile" && <ProfilePage data={data} onAttempt={(id) => void openAttempt(id)} busy={busy} />}
      {page === "settings" && <SettingsPage data={data} busy={busy} error={error} onSave={saveProfile} onLogout={() => void logout()} />}
      {page === "preparation" && preparation && <ExamPreparation key={preparation.activity.id} preparation={preparation} busy={busy} onBack={() => { setPreparation(undefined); setPage(workspaceReturnPage); setError(""); }} onStart={launchPreparation} />}
      {page === "workspace" && session && <WorkspacePage session={session} plugin={data.plugins.find((item) => item.section === session.activity.pluginId)} skillLabels={data.skillLabels} busy={busy} error={error} onBack={goHome} onAnswer={(answers) => setSession((current) => current ? { ...current, draft: { ...current.draft, answers } } : current)} onQuestion={setQuestionId} onSubmit={submit} onCoach={() => { setCoachOpen(true); void loadHistory(); }} onCause={(qid, tag, cause) => confirmCause(session.draft.attemptId, qid, tag, cause)} onAudioInterrupted={(reason) => { if (session.draft.mode === "mock") setSession((current) => current ? { ...current, draft: { ...current.draft, interruption: reason } } : current); }} />}
    </main>

    {coachOpen && session && currentQuestion && <CoachDrawer activity={session.activity} question={currentQuestion} draft={session.draft} result={session.result} data={data} lines={coachLines} loading={coachLoading} error={coachError} failedMessage={failedMessage} onClose={() => setCoachOpen(false)} onSend={sendCoach} onRetry={() => failedMessage && void sendCoach(failedMessage)} />}
    {error && <div className="toast-region" aria-live="polite"><div className="toast" role="alert"><Icon name="close" size={16} />{error}<button className="icon-button" aria-label="关闭提示" onClick={() => setError("")}><Icon name="close" size={15} /></button></div></div>}
    {!error && toast && <div className="toast-region" aria-live="polite"><div className="toast" role="status"><Icon name="sparkle" size={16} />{toast}</div></div>}
  </div>;
}

function NavButton({ item, active, onClick }: { item: { page: Page; label: string; icon: IconName }; active: boolean; onClick: () => void }) {
  return <button className={"nav-button" + (active ? " active" : "")} aria-label={item.label} title={item.label} onClick={onClick} aria-current={active ? "page" : undefined}><Icon name={item.icon} /><span className="nav-copy">{item.label}</span></button>;
}
function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return <header className="page-title-row"><div><h1>{title}</h1>{subtitle && <p className="page-subtitle">{subtitle}</p>}</div>{actions && <div className="page-actions">{actions}</div>}</header>;
}
function HomePage({ data, today, tasks, onPage, onTask, onActivity, onLock, onSetup, busy, onConfirmProposal, onDismissProposal, onRetryProposal }: {
  data: BootstrapData; today: string; tasks: PlanTask[]; onPage: (page: Page) => void; onTask: (task: PlanTask) => void; onActivity: (id: string) => void;
  onLock: (task: PlanTask) => void; onSetup: () => void; busy: boolean;
  onConfirmProposal: (id: string) => void; onDismissProposal: (id: string) => void; onRetryProposal: () => void;
}) {
  const complete = tasks.filter((task) => task.status === "done").length;
  const firstReading = data.activities.find((activity) => activity.pluginId === "reading");
  const answered = data.attempts.reduce((sum, item) => sum + item.score, 0);
  const total = data.attempts.reduce((sum, item) => sum + item.total, 0);
  const planFailed = data.planProposal.status === "failed";
  const emptyTitle = data.planProposal.status === "generating" ? "AI 正在整理你的计划" : planFailed ? "暂时没有已确认的计划" : "先做一道短练习，计划会从这里开始";
  const emptyNote = planFailed ? "你仍可从题库自主选择练习；之后可以重试 AI 计划。" : "你可以先做一份阅读练习，计划会结合新的学习记录逐步形成。";
  return <div className="page-content">
    <PageHeader title="今日学习" subtitle="今天先完成一小步，一项一项来。" actions={<span className="mode-pill"><Icon name="time" size={15} />{monthDay(today)}</span>} />
    {!data.profile.setupComplete && <section className="setup-message"><strong>先定一个适合自己的节奏</strong>告诉我目标分数、考试日期和每天能投入的时间，我会据此安排今天的练习。<div style={{ marginTop: 12 }}><button className="button button-outline button-small" onClick={onSetup}>设置学习目标 <Icon name="arrow" size={14} /></button></div></section>}
    <div className="plan-context"><div className="plan-context-copy"><span>{data.profile.dailyMinutes} 分钟 / 天</span><span className="context-dot" /><span>听力目标 {data.profile.targetListening.toFixed(1)}</span><span className="context-dot" /><span>阅读目标 {data.profile.targetReading.toFixed(1)}</span><span className="context-dot" /><span>{data.dueReviews} 道到期复习</span></div><span className="welcome-note">{data.profile.setupComplete ? "今天确认后保持固定；今天的新证据用于明日规划。" : "设置目标后，AI 会结合练习记录安排今天的题组。"}</span></div>
    <PlanProposalPanel proposal={data.planProposal} currentPlan={data.plan} today={today} dailyMinutes={data.profile.dailyMinutes} skillLabels={data.skillLabels} hasPlan={data.plan.some((task) => task.status !== "expired")} busy={busy} onConfirm={onConfirmProposal} onDismiss={onDismissProposal} onRetry={onRetryProposal} />
    <div className="section-heading"><h2>今天的任务 <span className="small-count">{complete}/{tasks.length} 已完成</span></h2><div className="inline-actions"><button className="text-action" onClick={() => onPage("mock")}>查看完整模考 <Icon name="arrow" size={14} /></button></div></div>
    <div className="task-list">{tasks.length ? tasks.map((task, index) => <TaskRow key={task.id} task={task} index={index} onStart={() => onTask(task)} onLock={() => onLock(task)} busy={busy} skillLabels={data.skillLabels} />) :
      <div className="empty-callout"><Icon name="sparkle" /><div className="empty-callout-copy"><strong>{emptyTitle}</strong><p>{emptyNote}</p></div><div className="empty-callout-actions"><button className="button button-primary button-small" onClick={() => firstReading ? onActivity(firstReading.id) : onPage("reading")}>开始阅读练习 <Icon name="arrow" size={14} /></button></div></div>}</div>
    <div className="home-lower">
      <section className="home-lower-block"><h2>开始一项练习</h2><p>短练习的成绩只作为观察线索，不会换算成雅思分数。</p>
        <div className="quick-links"><button className="quick-link" onClick={() => onPage("listening")}><span className="library-icon"><Icon name="headphones" /></span><span><strong>听力练习</strong><small>听取日期、地点与细节</small></span><Icon name="arrow" size={16} /></button><button className="quick-link" onClick={() => onPage("reading")}><span className="library-icon"><Icon name="book" /></span><span><strong>阅读练习</strong><small>定位依据与同义改写</small></span><Icon name="arrow" size={16} /></button></div>
      </section>
      <section className="home-lower-block"><h2>最近的学习记录</h2><p>分科保存原始正确题数，不根据少量题目猜测 Band 分数。</p>
        {data.attempts.length ? <div className="attempt-list">{data.attempts.slice(0, 3).map((item) => <div className="attempt-row" key={item.attemptId}><span>{sectionLabel[item.pluginId]} · {new Date(item.submittedAt).toLocaleDateString("zh-CN")}</span><strong className="attempt-result">{item.score} / {item.total}</strong></div>)}</div> : <div className="empty-state compact-empty"><Icon name="chart" /><h2>完成第一次练习后，这里会留下记录</h2><p>画像会逐步累积新题表现，不只看一次分数。累计 {answered}/{total}。</p></div>}
      </section>
    </div>
  </div>;
}
function PlanProposalPanel({ proposal, currentPlan, today, dailyMinutes, skillLabels, hasPlan, busy, onConfirm, onDismiss, onRetry }: {
  proposal: BootstrapData["planProposal"]; currentPlan: PlanTask[]; today: string; dailyMinutes: number; skillLabels: Record<string, string>; hasPlan: boolean; busy: boolean; onConfirm: (id: string) => void; onDismiss: (id: string) => void; onRetry: () => void;
}) {
  if (proposal.status === "idle" || proposal.status === "confirmed" || proposal.status === "dismissed") return null;
  return <section className={"plan-proposal " + (proposal.status === "failed" ? "plan-proposal-error" : "")} aria-live="polite">
    {proposal.status === "generating" && <><strong><Icon name="sparkle" size={16} />AI 正在整理个性化计划</strong><p>你可以继续学习；完成后会在这里显示调整建议。</p></>}
    {proposal.status === "failed" && <><strong><Icon name="close" size={16} />暂时无法生成新计划</strong><p>{proposal.error ?? "AI 规划暂不可用，请稍后重试。"} {hasPlan ? "当前已确认的计划仍然保留。" : "你可以先自主练习，之后再重试生成计划。"}</p><button className="button button-outline button-small" onClick={onRetry} disabled={busy}>重试规划</button></>}
    {proposal.status === "ready" && <>
      <strong><Icon name="sparkle" size={16} />AI 学习计划建议</strong>
      <p>先查看今天的小题组、预计用时和训练重点。确认后今天的计划固定；本日新产生的学习证据会用于明日规划。</p>
      <ProposalSchedule proposal={proposal} currentPlan={currentPlan} today={today} dailyMinutes={dailyMinutes} skillLabels={skillLabels} />
      {proposal.changes.length > 0 && <p className="plan-change-summary">相较当前计划：新增 {proposal.changes.filter((item) => item.kind === "added").length} 项 · 调整 {proposal.changes.filter((item) => item.kind === "updated").length} 项 · 移除 {proposal.changes.filter((item) => item.kind === "removed").length} 项</p>}
      <div className="plan-proposal-actions"><button className="button button-primary button-small" onClick={() => proposal.id && onConfirm(proposal.id)} disabled={busy || !proposal.id}>{proposal.changes.length ? "确认并应用今天的计划" : "确认今天的计划"}</button><button className="button button-outline button-small" onClick={() => proposal.id && onDismiss(proposal.id)} disabled={busy || !proposal.id}>暂不应用</button></div>
    </>}
  </section>;
}
function ProposalSchedule({ proposal, currentPlan, today, dailyMinutes, skillLabels }: { proposal: BootstrapData["planProposal"]; currentPlan: PlanTask[]; today: string; dailyMinutes: number; skillLabels: Record<string, string> }) {
  const tasks = [...(proposal.tasks ?? []), ...currentPlan.filter((task) => task.locked || task.status === "done")]
    .filter((task) => task.date === today)
    .sort((a, b) => a.date.localeCompare(b.date) || a.pluginId.localeCompare(b.pluginId));
  const minutes = tasks.reduce((sum, task) => sum + task.minutes, 0);
  return <div className="proposal-schedule"><section className="proposal-day">
    <h3>{new Date(today + "T12:00:00").toLocaleDateString("zh-CN", { month: "numeric", day: "numeric", weekday: "long" })}<span>{minutes} / {dailyMinutes} 分钟（含保留任务）</span></h3>
    {tasks.length ? <ol>{tasks.map((task) => <li key={task.id}><div><strong>{task.title}{task.locked || task.status === "done" ? " · 保留" : ""}</strong><span>{task.pluginId === "reading" ? "阅读" : "听力"} · {task.kind === "review" ? "错题复习" : task.kind === "diagnostic" ? "基线练习" : "专项练习"} · {task.questionIds?.length ?? 0} 道题 · {task.minutes} 分钟{task.focusSkillTag ? " · " + (skillLabels[task.focusSkillTag] ?? task.focusSkillTag) : ""}</span><p>{task.reason}</p></div></li>)}</ol> : <p className="proposal-rest">今天暂时没有候选任务，可以从题库自主练习。</p>}
  </section></div>;
}
function TaskRow({ task, index, onStart, onLock, busy, skillLabels }: { task: PlanTask; index: number; onStart: () => void; onLock: () => void; busy: boolean; skillLabels: Record<string, string> }) {
  const date = new Date(task.date + "T12:00:00").toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
  return <article className={"task-row" + (index === 0 && task.status !== "done" ? " featured" : "")}><span className="task-index">{String(index + 1).padStart(2, "0")}</span><div className="task-copy"><strong>{task.title}</strong><p>{task.reason}</p><span className="task-focus">{task.questionIds?.length ?? 0} 道题{task.questionKind ? " · " + (task.questionKind === "choice" ? "选择题" : task.questionKind === "tfng" ? "判断题" : "填空题") : ""}{task.focusSkillTag ? " · " + (skillLabels[task.focusSkillTag] ?? task.focusSkillTag) : ""}</span></div><span className="task-time">{date} · {task.minutes} 分钟</span><div className="task-controls">{task.status === "done" ? <span className="completion-status"><Icon name="circle-check" size={14} />已完成</span> : <><button className="task-lock" title={task.locked ? "解除锁定" : "锁定任务"} aria-label={task.locked ? "解除锁定" : "锁定任务"} onClick={onLock} disabled={busy}><Icon name={task.locked ? "lock" : "unlock"} size={16} /></button><button className={"button " + (index === 0 ? "button-primary" : "button-outline") + " button-small"} onClick={onStart} disabled={busy}>{task.kind === "review" ? "开始复习" : "开始练习"} <Icon name="arrow" size={14} /></button></>}</div></article>;
}
function MockPage({ data, onStart, busy }: { data: BootstrapData; onStart: (section: "reading" | "listening") => void; busy: boolean }) {
  return <div className="page-content"><PageHeader title="完整模考" subtitle="从现有题库组合完整试卷，按真实机考方式练习。听力与学术阅读分别进行。" />
    <div className="mock-list">{data.mockAvailability.map((item) => <article className="mock-card" key={item.section}><span className="mock-card-icon"><Icon name={item.section === "reading" ? "book" : "headphones"} /></span><div><h2>{item.section === "reading" ? "学术阅读" : "听力"} · 组合模拟卷</h2><p>{item.message}</p><span className="mock-count"><Icon name={item.ready ? "circle-check" : "time"} size={14} />{item.questions} / {item.expected} 道题</span></div><button className="button button-primary button-small" onClick={() => onStart(item.section)} disabled={!item.ready || busy}>{item.ready ? "进入考前准备" : "材料未齐"}</button></article>)}</div>
    <p className="footer-note">组合模拟卷由独立分段材料组成。正式开考后倒计时持续运行，交卷后可查看答案与解析。</p>
  </div>;
}
function ReviewPage({ data, onStart }: { data: BootstrapData; onStart: (activityId: string, ids: string[]) => void }) {
  const groups = useMemo(() => { const map = new Map<string, typeof data.reviewQueue>(); for (const item of data.reviewQueue) map.set(item.activityId, [...(map.get(item.activityId) ?? []), item]); return [...map.entries()]; }, [data.reviewQueue]);
  return <div className="page-content"><PageHeader title="错题复习" subtitle="答错的题按 1、3、7、14 天的间隔回来。复习答对后会逐渐拉长间隔。" actions={<span className="mode-pill">{data.dueReviews} 道今天到期</span>} />
    {groups.length ? <div className="review-list">{groups.map(([id, items]) => <article className="review-card" key={id}><div><span className="sample-label">{sectionLabel[items[0]!.pluginId]} · 到期 {items.length} 道</span><h2>{items[0]!.prompt}</h2><p>最近一次：{items[0]!.lastResult === "correct" ? "答对" : "需要再试一次"} · 连续独立答对 {items[0]!.streak} 次</p></div><button className="button button-outline button-small" onClick={() => onStart(id, items.map((item) => item.questionId))}>开始复习 <Icon name="arrow" size={14} /></button></article>)}</div> : <div className="empty-state"><Icon name="repeat" /><h2>目前没有到期复习</h2><p>做错的题会进入队列；答对后按 1、3、7、14 天的节奏再回来。</p></div>}
  </div>;
}
function LibraryPage({ section, data, onStart }: { section: "reading" | "listening"; data: BootstrapData; onStart: (id: string) => void }) {
  const activities = useMemo(() => data.activities.filter((item) => item.pluginId === section), [data.activities, section]);
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<0 | 1 | 2 | 3>(0);
  const [part, setPart] = useState<0 | 1 | 2 | 3 | 4>(0);
  const [limit, setLimit] = useState(20);
  useEffect(() => { setLimit(20); setPart(0); }, [section]);
  useEffect(() => setLimit(20), [query, level, part]);
  const partCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const item of activities) if (item.part) counts.set(item.part, (counts.get(item.part) ?? 0) + 1);
    return counts;
  }, [activities]);
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return activities.filter((item) => (level === 0 || item.difficulty === level) && (part === 0 || item.part === part) && (!keyword || item.title.toLowerCase().includes(keyword) || item.description.toLowerCase().includes(keyword)));
  }, [activities, level, part, query]);
  const visible = filtered.slice(0, limit);
  const title = section === "reading" ? "阅读练习" : "听力练习";
  const description = section === "reading" ? "从短篇文章开始，练习定位证据、识别改写和判断题逻辑。" : "听一段材料，再从日期、地点和具体细节里寻找答案。";
  return <div className="page-content">
    <PageHeader title={title} subtitle={description} actions={<span className="mode-pill">{filtered.length} / {activities.length} 份练习</span>} />
    <div className="library-toolbar">
      <label className="search-field"><Icon name="search" size={17} /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索练习标题或关键词" aria-label="搜索练习" /></label>
      <div className="library-filters">
        <div className="filter-chips" role="group" aria-label="按考试分段筛选">
          <button className={"filter-chip" + (part === 0 ? " active" : "")} aria-pressed={part === 0} onClick={() => setPart(0)}>全部分段</button>
          {partOptions(section).map((value) => <button key={value} className={"filter-chip" + (part === value ? " active" : "")} aria-pressed={part === value} onClick={() => setPart(value)}>{partLabel[section][value]}<span className="chip-count">{partCounts.get(value) ?? 0}</span></button>)}
        </div>
        <div className="filter-chips" role="group" aria-label="按难度筛选">
          {([0, 1, 2, 3] as const).map((value) => <button key={value} className={"filter-chip" + (level === value ? " active" : "")} aria-pressed={level === value} onClick={() => setLevel(value)}>{value === 0 ? "全部难度" : difficultyLabel[value]}</button>)}
        </div>
      </div>
    </div>
    {!activities.length ? <div className="empty-state"><Icon name="file" /><h2>暂时没有可用的{sectionLabel[section]}练习</h2><p>新的练习内容准备好后会显示在这里。</p></div>
      : !filtered.length ? <div className="empty-state"><Icon name="search" /><h2>没有匹配的练习</h2><p>换个关键词，或把「{part === 0 ? "全部分段" : partLabel[section][part]}」与难度筛选切回「全部难度」。</p></div>
      : <>
        <div className="library-list">{visible.map((item) => <article className="library-row" key={item.id}><span className="library-icon"><Icon name={section === "listening" ? "headphones" : "book"} /></span><div className="library-body"><h2 className="library-title"><span className="library-title-text" title={item.title}>{item.title}</span>{item.sample && <span className="sample-chip">原创演示</span>}</h2><p className="library-desc" title={item.description}>{item.description || "练习材料"}</p></div><div className="library-meta">{item.part && <span className="chip part-chip">{partLabel[section][item.part]}</span>}<span className="chip"><Icon name="time" size={13} />约 {item.minutes} 分钟</span><span className="chip"><Icon name="file" size={13} />{item.questions.length} 道题</span><span className="chip"><Icon name="gauge" size={13} />{difficultyLabel[item.difficulty]}</span></div><button className="button button-outline button-small" onClick={() => onStart(item.id)}>开始练习 <Icon name="arrow" size={14} /></button></article>)}</div>
        {filtered.length > limit && <div className="load-more"><button className="button button-soft" onClick={() => setLimit((value) => value + 20)}>加载更多（还有 {filtered.length - limit} 份）</button></div>}
      </>}
  </div>;
}
function ProfilePage({ data, onAttempt, busy }: { data: BootstrapData; onAttempt: (id: string) => void; busy: boolean }) {
  const total = data.attempts.reduce((sum, item) => sum + item.total, 0);
  const correct = data.attempts.reduce((sum, item) => sum + item.score, 0);
  return <div className="page-content"><PageHeader title="学习画像" subtitle="短练习保留原始答对数，不用少量题目猜测 Band 分数。重复的新题表现会逐步累积证据。" />
    <div className="data-grid"><DataStat label="最近 40 次答对" value={correct + " / " + total} /><DataStat label="最近 40 次正确率" value={total ? percent(correct, total) + "%" : "暂无记录"} /><DataStat label="到期复习" value={data.dueReviews + " 道"} /></div>
    <section className="profile-evidence"><div className="section-heading"><h2>听力与阅读能力证据</h2><span className="mode-pill">新题表现优先</span></div>
      {data.evidence.length ? <div className="evidence-list">{data.evidence.map((item) => <article className="evidence-row" key={item.pluginId + ":" + item.skillTag}><strong>{data.skillLabels[item.skillTag] ?? item.skillTag}</strong><span>{sectionLabel[item.pluginId]} · 近 30 天独立答对 {item.recentIndependentCorrect ?? 0}/{item.recentIndependentSamples ?? 0} · 用提示 {item.recentHinted ?? 0}</span><div className="evidence-meter"><i style={{ width: percent(item.recentIndependentCorrect ?? 0, item.recentIndependentSamples ?? 0) + "%" }} /></div><span className="confidence">{item.evidenceStatus === "insufficient" ? "证据不足 · 需要基线练习" : confidenceText(item.confidence)}{item.userConfirmedCause ? " · " + item.userConfirmedCause : ""}</span></article>)}</div> : <div className="empty-callout"><Icon name="chart" /><div className="empty-callout-copy"><strong>先完成一次练习，画像才会开始形成</strong><p>一次结果只是线索；重复的新题表现才会提高判断把握。</p></div></div>}
    </section>
    <section className="profile-attempts"><div className="section-heading"><h2>最近练习</h2><span className="small-count">{data.attempts.length} 次已提交</span></div>
      {data.attempts.length ? <div className="attempt-list">{data.attempts.map((item) => <div className="attempt-row" key={item.attemptId}><span>{sectionLabel[item.pluginId]} · {item.mode === "mock" ? "完整模考" : item.mode === "review" ? "错题复习" : "专项练习"} · {new Date(item.submittedAt).toLocaleString("zh-CN")}</span><strong className="attempt-result">{item.score} / {item.total}</strong><button type="button" className="text-action" onClick={() => onAttempt(item.attemptId)} disabled={busy}>查看复盘</button></div>)}</div> : <div className="empty-state compact-empty"><Icon name="file" /><h2>还没有提交的练习</h2><p>提交后会看到答案、提示使用情况和文章证据。</p></div>}
    </section>
  </div>;
}
function DataStat({ label, value }: { label: string; value: string }) { return <div className="data-stat"><span>{label}</span><strong>{value}</strong></div>; }
function confidenceText(value: "emerging" | "developing" | "established") { return value === "emerging" ? "观察中" : value === "developing" ? "有一些证据" : "多次观察"; }
type GoalForm = { targetListening: number; targetReading: number; examDate: string; dailyMinutes: number };
function ProfileForm({ value, busy, saved, error, onChange, onSubmit }: { value: GoalForm; busy: boolean; saved: boolean; error: string; onChange: (value: GoalForm) => void; onSubmit: (event: FormEvent) => void }) {
  const bands = Array.from({ length: 17 }, (_, index) => (index + 2) / 2);
  return <form className="profile-form-inner" onSubmit={onSubmit} aria-busy={busy}><fieldset className="profile-form-fields" disabled={busy}><div className="form-grid">
    <label className="field"><span>听力目标分数</span><select className="input" value={value.targetListening} onChange={(event) => onChange({ ...value, targetListening: Number(event.target.value) })}>{bands.map((score) => <option key={score} value={score}>{score.toFixed(1)}</option>)}</select></label>
    <label className="field"><span>阅读目标分数</span><select className="input" value={value.targetReading} onChange={(event) => onChange({ ...value, targetReading: Number(event.target.value) })}>{bands.map((score) => <option key={score} value={score}>{score.toFixed(1)}</option>)}</select></label>
    <label className="field"><span>考试日期</span><input className="input" type="date" required value={value.examDate} onChange={(event) => onChange({ ...value, examDate: event.target.value })} /></label>
    <label className="field"><span>每日可投入时间</span><select className="input" value={value.dailyMinutes} onChange={(event) => onChange({ ...value, dailyMinutes: Number(event.target.value) })}>{[15, 20, 30, 45, 60, 90, 120, 180].map((minutes) => <option key={minutes} value={minutes}>{minutes} 分钟</option>)}</select></label>
  </div></fieldset><div className="profile-form-actions"><p className={"profile-save-feedback" + (error ? " is-error" : "")} role={error ? "alert" : "status"}>{busy ? "正在保存目标，请稍候…" : error ? "保存未完成：" + error : saved ? "目标已保存。" : ""}</p><button type="submit" className="button button-primary" disabled={busy || saved}>{busy ? "保存中…" : saved ? "已保存" : "保存目标"} <Icon name={saved ? "circle-check" : "arrow"} size={15} /></button></div></form>;
}
function SettingsPage({ data, busy, error, onSave, onLogout }: { data: BootstrapData; busy: boolean; error: string; onSave: (value: Omit<BootstrapData["profile"], "id" | "updatedAt">) => Promise<boolean>; onLogout: () => void }) {
  const [form, setForm] = useState({ targetListening: data.profile.targetListening, targetReading: data.profile.targetReading, examDate: data.profile.examDate, dailyMinutes: data.profile.dailyMinutes });
  const [saved, setSaved] = useState(false);
  useEffect(() => setForm({ targetListening: data.profile.targetListening, targetReading: data.profile.targetReading, examDate: data.profile.examDate, dailyMinutes: data.profile.dailyMinutes }), [data.profile]);
  return <div className="page-content"><PageHeader title="设置" subtitle="调整备考目标和每天的学习节奏。" />
    <section className="profile-form profile-edit"><div><h2>学习偏好</h2><p className="profile-note">这些设置会帮助我们安排适合你的练习时间。你可以随时调整。</p></div><ProfileForm value={form} busy={busy} saved={saved} error={error} onChange={(value) => { setForm(value); setSaved(false); }} onSubmit={(event) => { event.preventDefault(); if (!busy && !saved) void onSave({ ...form, setupComplete: true }).then(setSaved); }} /></section>
    <section className="profile-form profile-edit account-panel"><div><h2>演示账号</h2><p className="profile-note">所有使用演示密码登录的人会共用这一份学习记录。</p></div><button className="button button-soft" onClick={onLogout}>退出登录</button></section>
  </div>;
}

type ExamViewSnapshot = {
  attemptId: string;
  currentQuestionId?: string;
  passageScrollTop: number;
  questionScrollTop: number;
  splitScrollTop: number;
  splitHeight: number;
  expandedPassage: boolean;
  audioSource: string;
  audioTime: number;
  audioPaused: boolean;
  audioVolume: number;
};

function captureExamView(root: HTMLElement | null, attemptId: string, currentQuestionId?: string): ExamViewSnapshot | null {
  if (!root) return null;
  const current = [...root.querySelectorAll<HTMLElement>("[data-question]")].find((node) => node.classList.contains("is-current") || node.closest(".exam-q")?.classList.contains("is-current"));
  const audio = root.querySelector<HTMLAudioElement>("[data-audio]");
  return {
    attemptId,
    currentQuestionId: currentQuestionId ?? current?.dataset.question,
    passageScrollTop: root.querySelector<HTMLElement>(".exam-passage-scroll")?.scrollTop ?? 0,
    questionScrollTop: root.querySelector<HTMLElement>(".exam-questions")?.scrollTop ?? 0,
    splitScrollTop: root.querySelector<HTMLElement>(".exam-split")?.scrollTop ?? 0,
    splitHeight: root.querySelector<HTMLElement>(".exam-split")?.getBoundingClientRect().height ?? 0,
    expandedPassage: Boolean(root.querySelector(".exam-split.is-expanded")),
    audioSource: audio?.currentSrc || audio?.src || "",
    audioTime: audio?.currentTime ?? 0,
    audioPaused: audio?.paused ?? true,
    audioVolume: audio?.volume ?? 1,
  };
}

function restoreExamView(root: HTMLElement, snapshot: ExamViewSnapshot): () => void {
  const split = root.querySelector<HTMLElement>(".exam-split");
  if (split && snapshot.splitHeight > 0) split.style.setProperty("--exam-result-split-height", `${snapshot.splitHeight}px`);
  root.querySelector<HTMLElement>(".exam-passage-scroll")?.scrollTo({ top: snapshot.passageScrollTop });
  root.querySelector<HTMLElement>(".exam-questions")?.scrollTo({ top: snapshot.questionScrollTop });
  split?.scrollTo({ top: snapshot.splitScrollTop });
  const expand = root.querySelector<HTMLButtonElement>("[data-expand-passage]");
  split?.classList.toggle("is-expanded", snapshot.expandedPassage);
  if (expand) {
    expand.classList.toggle("is-on", snapshot.expandedPassage);
    expand.setAttribute("aria-pressed", String(snapshot.expandedPassage));
    expand.setAttribute("aria-label", snapshot.expandedPassage ? "Collapse passage" : "Expand passage");
  }
  for (const node of root.querySelectorAll(".is-current")) node.classList.remove("is-current");
  if (snapshot.currentQuestionId) {
    const question = [...root.querySelectorAll<HTMLElement>("[data-question]")].find((node) => node.dataset.question === snapshot.currentQuestionId);
    question?.closest(".exam-q")?.classList.add("is-current");
    question?.classList.add("is-current");
    [...root.querySelectorAll<HTMLButtonElement>(".exam-cell[data-cell]")].find((node) => node.dataset.cell === snapshot.currentQuestionId)?.classList.add("is-current");
  }
  const audio = root.querySelector<HTMLAudioElement>("[data-audio]");
  if (!audio) return () => undefined;
  if (snapshot.audioSource && audio.src !== snapshot.audioSource) audio.src = snapshot.audioSource;
  audio.volume = snapshot.audioVolume;
  for (const tab of root.querySelectorAll<HTMLButtonElement>("[data-audio-tab]")) {
    const source = tab.dataset.audioSrc ? new URL(tab.dataset.audioSrc, document.baseURI).href : "";
    const active = source === (snapshot.audioSource || audio.src);
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  }
  let cancelled = false;
  const restorePlayback = () => {
    if (cancelled) return;
    try { audio.currentTime = snapshot.audioTime; } catch { /* wait for usable media metadata */ }
    if (snapshot.audioPaused) audio.pause();
    else void audio.play().catch(() => undefined);
  };
  if (audio.readyState >= 1) restorePlayback();
  else audio.addEventListener("loadedmetadata", restorePlayback, { once: true });
  return () => {
    cancelled = true;
    audio.removeEventListener("loadedmetadata", restorePlayback);
  };
}

function WorkspacePage({ session, plugin, skillLabels, busy, error, onBack, onAnswer, onQuestion, onSubmit, onCoach, onCause, onAudioInterrupted }: {
  session: Session; plugin?: BootstrapData["plugins"][number]; skillLabels: Record<string, string>; busy: boolean; error: string; onBack: () => void; onAnswer: (answers: Record<string, string>) => void;
  onQuestion: (id: string) => void; onSubmit: (answers: Record<string, string>, questionTimeSeconds: Record<string, number>) => Promise<boolean>;
  onCoach: () => void; onCause: (qid: string, tag: string, cause: string) => Promise<boolean>; onAudioInterrupted: (reason: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onAnswer, onQuestion, onSubmit });
  callbacks.current = { onAnswer, onQuestion, onSubmit };
  const { activity, draft, result } = session;
  const answerKey = JSON.stringify(draft.answers);
  const timerState = useRef({ attemptId: draft.attemptId, seconds: { ...(draft.questionTimeSeconds ?? {}) } });
  if (timerState.current.attemptId !== draft.attemptId) timerState.current = { attemptId: draft.attemptId, seconds: { ...(draft.questionTimeSeconds ?? {}) } };
  const latestAnswers = useRef(draft.answers);
  latestAnswers.current = draft.answers;
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const abandoningAttempt = useRef(false);
  const revisionRef = useRef(draft.saveRevision ?? 0);
  useEffect(() => { revisionRef.current = draft.saveRevision ?? 0; }, [draft.attemptId]);
  const nextRevision = useCallback(() => {
    revisionRef.current = Math.max(revisionRef.current + 1, Date.now());
    return revisionRef.current;
  }, []);
  const activeQuestion = useRef<string | undefined>(undefined);
  const submittedView = useRef<ExamViewSnapshot | null>(null);
  const resultRef = useRef(result);
  resultRef.current = result;
  const enqueueDraftSave = useCallback((keepalive = false) => {
    if (abandoningAttempt.current) return Promise.resolve();
    const attemptId = timerState.current.attemptId;
    const answers = { ...latestAnswers.current };
    const seconds = { ...timerState.current.seconds };
    const revision = nextRevision();
    const request = saveQueue.current.catch(() => undefined).then(() => api.saveDraft(attemptId, answers, seconds, revision, keepalive));
    saveQueue.current = request.then(() => undefined, () => undefined);
    return request;
  }, [nextRevision]);
  const flushDraftOnExit = useCallback(() => {
    if (abandoningAttempt.current || resultRef.current) return;
    const attemptId = timerState.current.attemptId;
    const answers = { ...latestAnswers.current };
    const seconds = { ...timerState.current.seconds };
    void api.saveDraft(attemptId, answers, seconds, nextRevision(), true).catch((reason) => console.error("Final draft save failed", reason));
  }, [nextRevision]);
  const submitInFlight = useRef(false);
  const autoSubmit = useRef({ attemptId: draft.attemptId, started: false });
  const [timeoutState, setTimeoutState] = useState<"idle" | "submitting" | "failed">("idle");
  const [mountError, setMountError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [exitOpen, setExitOpen] = useState(false);
  const [noticeVisible, setNoticeVisible] = useState(true);
  useEffect(() => {
    setNoticeVisible(true);
    if (!draft.interruption || result) return;
    const timer = window.setTimeout(() => setNoticeVisible(false), 3500);
    return () => window.clearTimeout(timer);
  }, [draft.attemptId, draft.interruption, result]);
  const mock = draft.mode === "mock";
  const clockStorageKey = "ielts-exam-clock-" + draft.attemptId;
  const [clockStart, setClockStart] = useState(() => {
    try { return window.localStorage.getItem("ielts-exam-clock-" + draft.attemptId) ?? draft.startedAt; } catch { return draft.startedAt; }
  });
  useEffect(() => {
    let stored: string | null = null;
    try { stored = window.localStorage.getItem("ielts-exam-clock-" + draft.attemptId); } catch { /* storage unavailable */ }
    setClockStart(stored ?? draft.startedAt);
  }, [draft.attemptId, draft.startedAt]);
  const clock = useExamClock(mock ? draft.startedAt : clockStart, activity.minutes, mock, Boolean(result), draft.deadlineAt);
  useEffect(() => {
    const root = host.current;
    if (!root) return;
    root.inert = !result && (busy || (mock && clock.expired));
    if (mock && clock.expired) root.querySelector<HTMLDialogElement>("[data-submit-dialog]")?.close();
  }, [busy, clock.expired, mock, result]);
  const submitAttempt = useCallback(async (answers: Record<string, string>, questionTimeSeconds: Record<string, number>) => {
    if (resultRef.current || submitInFlight.current) return false;
    submitInFlight.current = true;
    try {
      if (activity.pluginId === "reading" || activity.pluginId === "listening") {
        submittedView.current = captureExamView(host.current, draft.attemptId, activeQuestion.current);
        if (draft.mode === "mock" && submittedView.current) submittedView.current.audioPaused = true;
      }
      await saveQueue.current.catch(() => undefined);
      const accepted = await callbacks.current.onSubmit(answers, questionTimeSeconds);
      return accepted !== false;
    } finally {
      submitInFlight.current = false;
    }
  }, [activity.pluginId, draft.attemptId]);
  const retryTimeoutSubmit = useCallback(() => {
    if (resultRef.current) return;
    setTimeoutState("submitting");
    void submitAttempt({ ...latestAnswers.current }, { ...timerState.current.seconds })
      .then((accepted) => setTimeoutState(accepted ? "idle" : "failed"))
      .catch(() => setTimeoutState("failed"));
  }, [submitAttempt]);
  useEffect(() => {
    autoSubmit.current = { attemptId: draft.attemptId, started: false };
    setTimeoutState("idle");
  }, [draft.attemptId]);
  useEffect(() => {
    if (result) setExitOpen(false);
  }, [result]);
  useEffect(() => {
    if (!mock || !clock.expired || result || busy || autoSubmit.current.started) return;
    autoSubmit.current.started = true;
    setExitOpen(false);
    setTimeoutState("submitting");
    void submitAttempt({ ...latestAnswers.current }, { ...timerState.current.seconds })
      .then((accepted) => setTimeoutState(accepted ? "idle" : "failed"))
      .catch(() => setTimeoutState("failed"));
  }, [busy, clock.expired, mock, result, submitAttempt]);
  const visibleQuestions = useMemo(() => {
    const selected = draft.questionIds?.length ? draft.questionIds : draft.mode === "review" ? draft.reviewQuestionIds : undefined;
    return selected?.length ? activity.questions.filter((question) => selected.includes(question.id)) : activity.questions;
  }, [activity.questions, draft.mode, draft.questionIds, draft.reviewQuestionIds]);
  useEffect(() => {
    if (!plugin || !host.current) return;
    let cleanup: void | (() => void);
    let disposed = false;
    let restoreFrame = 0;
    let restoreFrameNext = 0;
    let cleanupViewRestore: (() => void) | undefined;
    setMountError("");
    void import(/* @vite-ignore */ plugin.browserUrl).then((module: { mountPractice?: (root: HTMLElement, state: Record<string, unknown>) => void | (() => void) }) => {
      if (disposed || !host.current) return;
      if (typeof module.mountPractice !== "function") throw new Error("Invalid practice entry");
      cleanup = module.mountPractice(host.current, { activity, draft, result, skillLabels, now: api.serverNow,
        onAnswer: (answers: Record<string, string>) => {
          callbacks.current.onAnswer(answers);
        },
        onCurrentQuestion: (id: string) => { activeQuestion.current = id; callbacks.current.onQuestion(id); },
        onAudioInterrupted: (reason: string) => { if (draft.mode === "mock") setSessionInterrupted(reason); },
        onSubmit: async (answers: Record<string, string>) => {
          await submitAttempt(answers, { ...timerState.current.seconds });
        },
      });
      const snapshot = result ? submittedView.current : null;
      if (snapshot?.attemptId === draft.attemptId && (activity.pluginId === "reading" || activity.pluginId === "listening")) {
        restoreFrame = window.requestAnimationFrame(() => {
          restoreFrameNext = window.requestAnimationFrame(() => {
            if (disposed || !host.current || submittedView.current !== snapshot) return;
            cleanupViewRestore = restoreExamView(host.current, snapshot);
            if (snapshot.currentQuestionId) callbacks.current.onQuestion(snapshot.currentQuestionId);
            submittedView.current = null;
          });
        });
      }
    }).catch((reason: unknown) => { console.error("Practice module failed to load", reason); setMountError("这项练习暂时无法打开，请稍后重试。"); });
    return () => { disposed = true; window.cancelAnimationFrame(restoreFrame); window.cancelAnimationFrame(restoreFrameNext); cleanupViewRestore?.(); cleanup?.(); };
  }, [activity.id, plugin?.browserUrl, draft.attemptId, result?.submittedAt]);

  useEffect(() => {
    if (result) return;
    const root = host.current;
    if (!root) return;
    let dirtySeconds = 0;
    let savingTimes = false;
    let remainder = 0;
    let lastTick = performance.now();
    let wasVisible = document.visibilityState === "visible";
    const observed = new Set<Element>();
    const visibleRatios = new Map<Element, number>();
    const saveTimes = () => {
      if (savingTimes || dirtySeconds <= 0 || resultRef.current || abandoningAttempt.current) return false;
      savingTimes = true;
      const savedSeconds = dirtySeconds;
      setSaving(true);
      void enqueueDraftSave()
        .then(() => { dirtySeconds = Math.max(0, dirtySeconds - savedSeconds); setSaving(false); setSaveError(""); })
        .catch((reason) => { setSaving(false); setSaveError("逐题用时保存失败：" + errorMessage(reason)); })
        .finally(() => { savingTimes = false; });
      return true;
    };
    const sampleTime = (now: number, visible = document.visibilityState === "visible") => {
      const elapsed = Math.max(0, (now - lastTick) / 1000);
      lastTick = now;
      if (abandoningAttempt.current) { remainder = 0; return; }
      const id = activeQuestion.current;
      if (!visible || !id || resultRef.current) { remainder = 0; return; }
      remainder += elapsed;
      const seconds = Math.floor(remainder);
      if (!seconds) return;
      remainder -= seconds;
      timerState.current.seconds[id] = (timerState.current.seconds[id] ?? 0) + seconds;
      dirtySeconds += seconds;
      if (dirtySeconds >= 5) saveTimes();
    };
    const saveOnExit = () => {
      if (resultRef.current || abandoningAttempt.current) return;
      flushDraftOnExit();
    };
    const intersection = typeof IntersectionObserver === "undefined" ? undefined : new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && entry.intersectionRatio >= 0.15) visibleRatios.set(entry.target, entry.intersectionRatio);
        else visibleRatios.delete(entry.target);
      }
      const visible = [...visibleRatios.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] as HTMLElement | undefined;
      activeQuestion.current = visible?.dataset.question;
    }, { threshold: [0, 0.15, 0.35, 0.6, 0.85] });
    const observeQuestions = () => {
      for (const element of root.querySelectorAll("[data-question]")) {
        if (!observed.has(element)) { observed.add(element); intersection?.observe(element); }
      }
    };
    observeQuestions();
    const mutation = new MutationObserver(observeQuestions);
    mutation.observe(root, { childList: true, subtree: true });
    const interval = window.setInterval(() => sampleTime(performance.now()), 500);
    const onVisibility = () => {
      sampleTime(performance.now(), wasVisible);
      wasVisible = document.visibilityState === "visible";
      if (!wasVisible) saveOnExit();
    };
    const onPageHide = () => { sampleTime(performance.now(), wasVisible); saveOnExit(); };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      if (!resultRef.current && !abandoningAttempt.current) { sampleTime(performance.now(), wasVisible); saveOnExit(); }
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      mutation.disconnect();
      intersection?.disconnect();
    };
  }, [draft.attemptId, result?.submittedAt, enqueueDraftSave, flushDraftOnExit]);

  useEffect(() => {
    if (result || !Object.keys(draft.answers).length) return;
    const timer = window.setTimeout(() => {
      setSaving(true);
      void enqueueDraftSave()
        .then(() => { setSaving(false); setSaveError(""); })
        .catch((reason) => { setSaving(false); setSaveError("自动保存失败：" + errorMessage(reason)); });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [answerKey, draft.attemptId, result, enqueueDraftSave]);

  useEffect(() => {
    if (result) return;
    const interrupt = () => api.markInterrupted(draft.attemptId, "浏览器页面或标签关闭");
    window.addEventListener("beforeunload", interrupt);
    return () => window.removeEventListener("beforeunload", interrupt);
  }, [draft.attemptId, result]);

  function setSessionInterrupted(reason: string) {
    api.markInterrupted(draft.attemptId, reason);
    onAudioInterrupted(reason);
  }
  function resetClock() {
    if (!window.confirm("Reset the timer? This will restart the clock without changing your answers.")) return;
    const now = new Date().toISOString();
    try { window.localStorage.setItem(clockStorageKey, now); } catch { /* storage unavailable */ }
    setClockStart(now);
  }
  function requestExit() {
    if (result) { onBack(); return; }
    setExitOpen(true);
  }
  async function discardAttempt() {
    if (abandoningAttempt.current) return;
    abandoningAttempt.current = true;
    setMountError("");
    setSaving(true);
    try {
      await saveQueue.current.catch(() => undefined);
      await api.abandonAttempt(draft.attemptId);
      try {
        window.localStorage.removeItem("ielts-active-attempt");
        window.localStorage.removeItem(clockStorageKey);
        window.localStorage.removeItem("ielts-exam-flags-" + draft.attemptId);
        window.localStorage.removeItem("ielts-exam-part-" + draft.attemptId);
        window.localStorage.removeItem("ielts-exam-annotations-v1:" + draft.attemptId);
      } catch { /* storage unavailable */ }
      setExitOpen(false);
      onBack();
    } catch (reason) {
      abandoningAttempt.current = false;
      setMountError("放弃练习失败：" + errorMessage(reason));
    } finally {
      setSaving(false);
    }
  }
  function triggerPracticeControl(selector: string) {
    host.current?.querySelector<HTMLButtonElement>(selector)?.click();
  }
  const inlineFeedback = Boolean(result && (activity.pluginId === "reading" || activity.pluginId === "listening"));
  const showStudyTools = !result || inlineFeedback;

  useEffect(() => {
    if (!exitOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setExitOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exitOpen]);

  return <div className="page-content workspace-content exam-mode">
    <header className="exam-bar">
      <div className="exam-bar-left">
        <div className="exam-section-nav" role="group" aria-label="Test section"><strong className="exam-test-brand">IELTS</strong><span className="exam-section-option is-active" aria-current="page">{activity.pluginId === "reading" ? "Academic Reading" : "Listening"}</span></div>
        <span className="exam-bar-title" title={activity.title}>{mock ? "Computer mock test · Combination paper" : draft.mode === "review" ? "Review practice" : "Computer practice"}</span>
      </div>
      <div className="exam-bar-right">
        {!result && <span className="exam-save-pill" data-state={saving ? "saving" : saveError ? "error" : "saved"}>{saving ? "Saving…" : saveError ? "Not saved" : "Saved"}</span>}
        <span className={"exam-clock" + (!result && clock.expired ? " is-expired" : !result && clock.urgent ? " is-urgent" : "")} role="timer" aria-live={!result && (clock.urgent || clock.expired) ? "polite" : "off"} aria-label={result ? "Test submitted" : mock ? "Time remaining" : "Time elapsed"}>{result ? "Submitted" : clock.label}</span>
        <details className="exam-tools-menu">
          <summary aria-label="Test tools"><Icon name="menu" size={23} /><span>Tools</span></summary>
          <div className="exam-tools-popover" role="menu">
            <details className="exam-help"><summary>Help</summary><p>Use the question numbers to move through the test. Select text to highlight it or add a note. Select a flag to mark a question for review. Select the tick button to review and submit your answers.</p></details>
            {activity.pluginId === "listening" && result && <button type="button" role="menuitem" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); triggerPracticeControl("[data-transcript-toggle]"); }}>Transcript</button>}
            {showStudyTools && <>
              <button type="button" role="menuitem" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); triggerPracticeControl("[data-notes-toggle]"); }}>Notes</button>
              <button type="button" role="menuitem" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); triggerPracticeControl("[data-font-toggle]"); }}>Text size</button>
              {(!mock || result) && <button type="button" role="menuitem" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onCoach(); }}>AI tutor</button>}
              {!result && !mock && <button type="button" role="menuitem" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); resetClock(); }}>Reset timer</button>}
            </>}
            <button type="button" role="menuitem" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); requestExit(); }}>Exit test</button>
          </div>
        </details>
      </div>
    </header>
    {draft.interruption && !result && noticeVisible && <div className="notice"><Icon name="time" />A previous session was interrupted. Your answer draft has been restored.</div>}
    {error && <div className="notice error"><Icon name="close" />{error}</div>}
    {(mountError || !plugin) && <div className="notice error"><Icon name="close" />{mountError || "这项练习暂时无法打开，请稍后重试。"}</div>}
    {saveError && <div className="notice error"><Icon name="close" />{saveError}</div>}
    <div className="practice-host" ref={host} />
    {timeoutState !== "idle" && !result && <div className="exam-exit-overlay" role="presentation">
      <div className="exam-exit-dialog" role="dialog" aria-modal="true" aria-label="Time expired">
        <h2>{timeoutState === "submitting" ? "Time expired" : "自动提交失败"}</h2>
        <p>{timeoutState === "submitting" ? "考试时间已到，正在保存并提交答案…" : (error || "网络异常，答案尚未提交。请重试。")}</p>
        {timeoutState === "failed" && <div className="exam-exit-actions"><button type="button" className="button button-primary" onClick={retryTimeoutSubmit}>重新提交</button></div>}
      </div>
    </div>}
    {result && <ResultCauses session={session} onCause={onCause} onBack={onBack} busy={busy} saving={saving} />}
    {exitOpen && <div className="exam-exit-overlay" role="presentation" onClick={() => setExitOpen(false)}>
      <div className="exam-exit-dialog" role="dialog" aria-modal="true" aria-label="Exit practice" onClick={(event) => event.stopPropagation()}>
        <h2>{mock ? "Exit test?" : "Exit practice?"}</h2>
        <p>Leaving now will discard this attempt’s answers and timer. You can continue the test or exit this attempt.</p>
        <div className="exam-exit-actions">
          <button type="button" className="button button-primary" autoFocus onClick={() => setExitOpen(false)}>Continue test</button>
          <button type="button" className="button button-soft exam-exit-discard" onClick={() => void discardAttempt()}>Exit and discard</button>
        </div>
      </div>
    </div>}
  </div>;
}
function ResultCauses({ session, onCause, onBack, busy, saving }: { session: Session; onCause: (qid: string, tag: string, cause: string) => Promise<boolean>; onBack: () => void; busy: boolean; saving: boolean }) {
  const result = session.result!;
  const wrong = result.responses.filter((item) => !item.correct);
  return <section className="exam-causes cause-review"><h3>错因复盘</h3><p className="review-intro">这些只是复盘线索。选一个最接近的原因，之后会用新题继续验证。</p>
    {wrong.map((response, index) => { const question = session.activity.questions.find((item) => item.id === response.questionId); return question ? <CausePicker key={question.id} response={response} question={question} index={index + 1} onConfirm={(tag, cause) => onCause(question.id, tag, cause)} /> : null; })}
    {!wrong.length && <div className="empty-callout"><Icon name="circle-check" /><div className="empty-callout-copy"><strong>这次所有题目都答对了</strong><p>{result.responses.some((item) => !item.independent) ? "用过提示的题会单独标记；之后试试不用提示能否答对。" : "这次是独立完成的结果，继续用新题巩固会更可靠。"}</p></div></div>}
    <button className="button button-outline button-small" onClick={onBack}>返回学习 <Icon name="arrow" size={14} /></button><span className="autosave-label">{busy ? "正在提交…" : saving ? "保存中…" : result.sample ? "演示练习记录已保存" : "练习记录已保存"}</span>
  </section>;
}
function useExamClock(startedAt: string, minutes: number, countdown: boolean, stopped: boolean, deadlineAt?: string) {
  const [now, setNow] = useState(() => countdown ? api.serverNow() : Date.now());
  useEffect(() => { if (stopped) return; const tick = () => setNow(countdown ? api.serverNow() : Date.now()); tick(); const timer = window.setInterval(tick, 1000); return () => window.clearInterval(timer); }, [countdown, stopped]);
  const elapsed = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  const format = (seconds: number) => seconds >= 3600
    ? `${Math.floor(seconds / 3600)}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
    : `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  if (!countdown) return { label: format(elapsed), urgent: false, expired: false };
  const remaining = Math.max(0, Math.ceil(((deadlineAt ? Date.parse(deadlineAt) : Date.parse(startedAt) + minutes * 60_000) - now) / 1000));
  const expired = remaining === 0;
  return { label: expired ? "Time expired" : format(remaining), expired, urgent: !expired && remaining <= 300 };
}
function CausePicker({ response, question, index, onConfirm }: { response: AttemptResult["responses"][number]; question: PublicActivity["questions"][number]; index: number; onConfirm: (tag: string, cause: string) => Promise<boolean> }) {
  const [tag, setTag] = useState(question.skillTags[0] ?? "");
  const [cause, setCause] = useState("");
  const [saved, setSaved] = useState(false);
  const options = ["没定位到关键信息", "同义改写没识别出来", "忽略了范围或限定词", "听错了日期、数字或地点", "时间不够", "其他"];
  return <article className="cause-row"><div><strong>第 {index} 题 · {question.prompt}</strong><p>你的答案：{response.selected || "未作答"} · 参考答案：{response.correctAnswer}</p><p className="cause-evidence">依据：{response.evidence}</p></div><div className="cause-fields">
    <label className="field"><span>关联能力</span><select className="input" value={tag} onChange={(event) => setTag(event.target.value)}>{question.skillTags.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
    <label className="field"><span>我觉得错在</span><select className="input" value={cause} onChange={(event) => { setCause(event.target.value); setSaved(false); }}><option value="">选择一个原因</option>{options.map((item) => <option key={item}>{item}</option>)}</select></label>
    <button className="button button-soft button-small" disabled={!cause || saved} onClick={() => void onConfirm(tag, cause).then(setSaved)}>{saved ? "已记下" : "确认错因"}</button>
  </div></article>;
}
function CoachDrawer({ activity, question, draft, result, data, lines, loading, error, failedMessage, onClose, onSend, onRetry }: {
  activity: PublicActivity; question: PublicActivity["questions"][number]; draft: AnswerDraft; result?: AttemptResult; data: BootstrapData; lines: CoachLine[]; loading: boolean; error: string; failedMessage: string; onClose: () => void; onSend: (text: string) => void; onRetry: () => void;
}) {
  const [input, setInput] = useState("");
  const [contextOpen, setContextOpen] = useState(false);
  const [suggestion, setSuggestion] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const response = result?.responses.find((item) => item.questionId === question.id);
  const task = draft.taskId ? data.plan.find((item) => item.id === draft.taskId) : undefined;
  const related = data.evidence.filter((item) => question.skillTags.includes(item.skillTag));
  const part = activity.examParts?.find((item) => item.questionIds.includes(question.id));
  const source = activity.passage?.text ?? activity.passages?.find((item) => item.id === part?.passageId)?.text ?? "听力文本只作为导师上下文，不会显示在作答页面。";
  const priorErrors = data.attempts.reduce((sum, attempt) => sum + attempt.responses.filter((item) => !item.correct && item.skillTags.some((tag) => question.skillTags.includes(tag))).length, 0);
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" }); }, [lines, error]);
  function send(text: string) { const message = text.trim(); if (!message || loading || !data.aiConfigured) return; onSend(message); setInput(""); setSuggestion(false); }
  return <aside className="coach-drawer" aria-label="AI 学习导师">
    <header className="coach-header"><h2><Icon name="sparkle" />学习导师</h2><button className="icon-button" aria-label="关闭导师" onClick={onClose}><Icon name="close" /></button></header>
    <div className="coach-context"><div className="coach-context-line"><strong>当前材料：</strong>{activity.title}</div><div className="coach-context-line"><strong>当前题目：</strong>{question.prompt}</div><button className="coach-context-button" onClick={() => setContextOpen((value) => !value)}><Icon name="file" size={14} />{contextOpen ? "收起学习上下文" : "查看带入的学习上下文"}</button>
      {contextOpen && <div className="coach-context-detail">模式：{result ? "已提交复盘" : draft.mode === "mock" ? "完整模考" : "练习中"}<br />当前任务：{task ? task.title + " · " + task.reason : "自主练习"}<br />目标：听力 {data.profile.targetListening.toFixed(1)}、阅读 {data.profile.targetReading.toFixed(1)} · 每日 {data.profile.dailyMinutes} 分钟<br />当前作答：{draft.answers[question.id] || "尚未作答"}<br />提示记录：{draft.hintedQuestionIds.length ? draft.hintedQuestionIds.length + " 道题用过提示" : "尚无提示记录"}<br />相关能力：{question.skillTags.map((item) => data.skillLabels[item] ?? item).join("、")}<br />历史相似错题：{priorErrors} 道<br />能力证据：{related.length ? related.map((item) => (data.skillLabels[item.skillTag] ?? item.skillTag) + " 独立答对 " + item.independent + "/" + item.total).join("；") : "还没有相关记录"}<br />本题结果：{response ? response.correct ? "答对" : "答错" : "尚未提交"}<br />材料片段：{source.slice(0, 360)}{source.length > 360 ? "…" : ""}</div>}
    </div>
    <div className="coach-intro">我会先看题目和你的作答记录，再一起找线索。你可以直接说卡住的地方。</div>
    <div className="coach-messages" ref={list}>{lines.length ? lines.map((line) => <div className={"coach-message " + line.role} key={line.id}>{line.role === "assistant" && <span className="coach-bot-mark"><Icon name="sparkle" size={14} /></span>}<div className="coach-bubble">{line.text}</div></div>) : <p className="coach-empty">“这题我该先看哪里？”<br />“这两个选项怎么区分？”</p>}
      {!data.aiConfigured && <div className="coach-setup">学习导师暂时无法回复，请稍后再试。</div>}
      {response && !response.correct && <div className="coach-suggestions"><button className="suggestion-button" onClick={() => setSuggestion(true)}><Icon name="sparkle" size={14} />和我复盘这道错题</button></div>}
      {suggestion && <div className="coach-suggestions"><button className="suggestion-button" onClick={() => send("能结合这题的文章或录音证据，解释我可能错在哪里吗？")} disabled={!data.aiConfigured || loading}><Icon name="sparkle" size={14} />根据证据分析错因</button></div>}
      {error && <div className="coach-error" role="alert">{error}<button className="text-action" onClick={onRetry} disabled={loading || !failedMessage}>重试回复</button></div>}
    </div>
    <form className="coach-composer" onSubmit={(event) => { event.preventDefault(); send(input); }}><textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder={data.aiConfigured ? "告诉我你卡住的地方…" : "导师暂时休息中"} disabled={!data.aiConfigured || loading} /><button className="coach-send" aria-label="发送消息" disabled={!input.trim() || !data.aiConfigured || loading}><Icon name="send" size={16} /></button></form>
  </aside>;
}
