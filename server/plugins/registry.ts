import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Activity, PluginManifest, PublicActivity, Question, QuestionResult, Section } from "../../src/shared/domain.js";
import { assertActivity, assertManifest } from "../../src/shared/validation.js";
import type { LearnerSnapshot, PluginHost } from "./contract.js";

type PluginFailure = { name: string; reason: string };
type HintStrategy = (question: Question, activity: Activity) => string;
type CoachHandler = (snapshot: LearnerSnapshot, input?: string) => string;
type Grader = (activity: Activity, answers: Record<string, string>, hints: string[]) => QuestionResult[];

const safeLeaf = (name: string) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/.test(name);

export class PluginRegistry {
  private readonly manifests = new Map<string, PluginManifest>();
  private readonly activities = new Map<string, Activity>();
  private readonly graders = new Map<string, Grader>();
  private readonly hints = new Map<string, HintStrategy>();
  private readonly coachTools = new Map<string, Map<string, CoachHandler>>();
  private readonly labels = new Map<string, Record<string, string>>();
  private readonly releases: Array<() => void | Promise<void>> = [];
  readonly failures: PluginFailure[] = [];

  constructor(readonly root: string) {}

  async loadAll(): Promise<void> {
    const realRoot = await realpath(this.root);
    const folders = await readdir(realRoot, { withFileTypes: true });
    const pending = new Map<string, { manifest: PluginManifest; directory: string; moduleFile: string }>();
    for (const folder of folders) {
      if (!folder.isDirectory() || !safeLeaf(folder.name)) continue;
      const directory = resolve(realRoot, folder.name);
      try {
        const manifestPath = resolve(directory, "manifest.json");
        let manifestSource: string;
        try { manifestSource = await readFile(manifestPath, "utf8"); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        const parsed: unknown = JSON.parse(manifestSource);
        assertManifest(parsed);
        const manifest = parsed;
        if (manifest.id !== folder.name) throw new Error("插件目录名称必须与 manifest ID 一致");
        if (this.manifests.has(manifest.id) || pending.has(manifest.id)) throw new Error("插件 ID 重复");
        const moduleFile = resolve(directory, manifest.serverEntry);
        if (!moduleFile.startsWith(`${directory}${sep}`)) throw new Error("服务端入口超出插件目录");
        const fileStat = await stat(moduleFile);
        if (!fileStat.isFile() || !moduleFile.endsWith(".mjs")) throw new Error("服务端入口必须是存在的 .mjs 文件");
        pending.set(manifest.id, { manifest, directory, moduleFile });
      } catch (error) {
        this.failures.push({ name: folder.name, reason: error instanceof Error ? error.message : "插件载入失败" });
      }
    }
    while (pending.size) {
      let progressed = false;
      for (const [id, candidate] of [...pending]) {
        const dependencies = Object.entries(candidate.manifest.dependencies ?? {});
        const waiting = dependencies.some(([dependency]) => pending.has(dependency));
        if (waiting) continue;
        const missing = dependencies.find(([dependency]) => !this.manifests.has(dependency));
        if (missing) {
          this.failures.push({ name: id, reason: `插件依赖 ${missing[0]} 未加载。` });
          pending.delete(id);
          progressed = true;
          continue;
        }
        const mismatch = dependencies.find(([dependency, version]) => this.manifests.get(dependency)?.version !== version);
        if (mismatch) {
          this.failures.push({ name: id, reason: `插件依赖 ${mismatch[0]} 需要版本 ${mismatch[1]}。` });
          pending.delete(id);
          progressed = true;
          continue;
        }
        try { await this.activate(candidate.manifest, candidate.moduleFile); }
        catch (error) { this.failures.push({ name: id, reason: error instanceof Error ? error.message : "插件载入失败" }); }
        pending.delete(id);
        progressed = true;
      }
      if (!progressed) {
        for (const id of pending.keys()) this.failures.push({ name: id, reason: "插件依赖存在循环，或依赖的插件未能加载。" });
        pending.clear();
      }
    }
  }

  private async activate(manifest: PluginManifest, moduleFile: string): Promise<void> {
    const pluginModule = await import(pathToFileURL(moduleFile).href) as { activate?: (host: PluginHost) => void | Promise<void>; start?: () => void | Promise<void>; deactivate?: () => void | Promise<void> };
    if (typeof pluginModule.activate !== "function") throw new Error("插件必须提供 activate(host)");
    const staged = this.createStagingHost(manifest);
    await pluginModule.activate(staged.host);
    const registered = staged.get();
    if (staged.activities.some((activity) => activity.pluginId !== manifest.section)) throw new Error("练习区块与插件声明不一致");
    if (staged.activities.some((activity) => this.activities.has(activity.id))) throw new Error("练习 ID 重复");
    for (const activity of staged.activities) assertActivity(activity);
    await pluginModule.start?.();
    this.manifests.set(manifest.id, manifest);
    for (const activity of staged.activities) this.activities.set(activity.id, activity);
    if (registered.grader) this.graders.set(manifest.id, registered.grader);
    if (registered.hint) this.hints.set(manifest.id, registered.hint);
    if (registered.tools.size) this.coachTools.set(manifest.id, registered.tools);
    if (Object.keys(registered.skillLabels).length) this.labels.set(manifest.id, registered.skillLabels);
    if (pluginModule.deactivate) this.releases.push(pluginModule.deactivate);
  }

  async releaseAll(): Promise<void> {
    for (const release of this.releases.reverse()) await release();
    this.releases.length = 0;
  }

  private createStagingHost(manifest: PluginManifest) {
    const activities: Activity[] = [];
    const tools = new Map<string, CoachHandler>();
    let grader: Grader | undefined;
    let hint: HintStrategy | undefined;
    let skillLabels: Record<string, string> = {};
    const host: PluginHost = {
      manifest,
      registerActivity: (activity) => activities.push(activity),
      registerGrader: (registered) => {
        if (grader) throw new Error("一个插件只能注册一个判分器");
        grader = registered;
      },
      registerCoachTool: (name, _description, handler) => {
        if (!safeLeaf(name) || tools.has(name)) throw new Error("AI 工具名称无效或重复");
        tools.set(name, handler);
      },
      registerHintStrategy: (registered) => {
        if (hint) throw new Error("一个插件只能注册一个提示策略");
        hint = registered;
      },
      registerSkillTags: (registered) => { skillLabels = { ...skillLabels, ...registered }; },
    };
    return { host, activities, get: () => ({ grader, hint, tools, skillLabels }) };
  }

  manifestsForBrowser(): Array<{ id: string; section: Section; browserUrl: string }> {
    return [...this.manifests.values()].map((manifest) => ({ id: manifest.id, section: manifest.section, browserUrl: `/plugin-assets/${encodeURIComponent(manifest.id)}/${manifest.browserEntry.slice(2)}` }));
  }

  async readBrowserEntry(pluginId: string): Promise<Buffer> {
    const manifest = this.manifests.get(pluginId);
    if (!manifest) throw new Error("插件不可用");
    const directory = resolve(this.root, pluginId);
    const rootReal = await realpath(this.root);
    const directoryReal = await realpath(directory);
    if (directoryReal !== resolve(rootReal, pluginId)) throw new Error("插件目录无效");
    const file = resolve(directoryReal, manifest.browserEntry);
    if (!file.startsWith(`${directoryReal}${sep}`)) throw new Error("浏览器入口超出插件目录");
    return readFile(file);
  }

  activeManifests(): PluginManifest[] { return [...this.manifests.values()]; }
  builtinActivities(): Activity[] { return [...this.activities.values()]; }
  skillLabel(tag: string): string {
    for (const labels of this.labels.values()) if (labels[tag]) return labels[tag]!;
    return tag.split(".").at(-1) ?? tag;
  }
  grader(pluginId: string): Grader | undefined { return this.graders.get(pluginId); }
  hintStrategy(pluginId: string): HintStrategy | undefined { return this.hints.get(pluginId); }
  coachTool(pluginId: string, name: string): CoachHandler | undefined { return this.coachTools.get(pluginId)?.get(name); }
  findManifest(pluginId: string): PluginManifest | undefined { return this.manifests.get(pluginId); }

  allActivities(imported: Activity[]): Activity[] { return [...this.activities.values(), ...imported]; }

  findActivity(pluginId: string, activityId: string, imported: Activity[]): Activity | undefined {
    const activity = this.activities.get(activityId) ?? imported.find((item) => item.id === activityId);
    return activity?.pluginId === pluginId ? activity : undefined;
  }
}

export function toPublicActivity(activity: Activity): PublicActivity {
  const publicQuestion = (question: Question, index: number): PublicActivity["questions"][number] => {
    const result: PublicActivity["questions"][number] = {
      id: question.id,
      prompt: question.prompt,
      kind: question.kind,
      skillTags: [...question.skillTags],
      displayNumber: question.displayNumber ?? index + 1,
    };
    if (question.options) result.options = [...question.options];
    if (question.optionLabels) result.optionLabels = { ...question.optionLabels };
    if (question.displayNumber !== undefined) result.displayNumber = question.displayNumber;
    if (question.groupId !== undefined) result.groupId = question.groupId;
    if (question.groupTitle !== undefined) result.groupTitle = question.groupTitle;
    if (question.groupInstruction !== undefined) result.groupInstruction = question.groupInstruction;
    if (question.groupContext !== undefined) result.groupContext = question.groupContext;
    if (question.answerGroupId !== undefined) result.answerGroupId = question.answerGroupId;
    return result;
  };
  const result: PublicActivity = {
    ...(activity.examParts ? { examParts: activity.examParts.map((part) => ({
      part: part.part, sourceActivityId: part.sourceActivityId, questionIds: [...part.questionIds],
      ...(part.passageId !== undefined ? { passageId: part.passageId } : {}),
      ...(part.audioSectionIndex !== undefined ? { audioSectionIndex: part.audioSectionIndex } : {}),
    })) } : {}),
    id: activity.id,
    pluginId: activity.pluginId,
    title: activity.title,
    description: activity.description,
    minutes: activity.minutes,
    difficulty: activity.difficulty,
    sample: activity.sample,
    questions: activity.questions.map(publicQuestion),
  };
  if (activity.sourceName !== undefined) result.sourceName = activity.sourceName;
  if (activity.part !== undefined) result.part = activity.part;
  if (activity.mockId !== undefined) result.mockId = activity.mockId;
  if (activity.passage) result.passage = { title: activity.passage.title, text: activity.passage.text };
  if (activity.passages) result.passages = activity.passages.map(({ id, title, text }) => ({ id, title, text }));
  if (activity.audioUrl !== undefined) result.audioUrl = activity.audioUrl;
  if (activity.audioSections) result.audioSections = activity.audioSections.map(({ title, audioUrl }) => ({ title, audioUrl }));
  return result;
}

