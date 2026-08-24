// HR-2C Home refinement (2026-08-24) — Home-notification behaviour.
//
// The strict founder invariants (§3):
//   * dismissing the × MUST NOT change eligibility, availability, or
//     any HR record;
//   * the underlying training obligation, safety-training list, and
//     availability enforcement all remain identical after dismiss;
//   * dismissal survives page refresh (persisted);
//   * a NEW required course produces a NEW notificationKey → the bar
//     surfaces again even though the prior dismissal row still exists.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createCourse, publishDraft, updateDraft } from "@/lib/hr/training/courses";
import { createQuestion } from "@/lib/hr/training/questions";
import { uploadTrainingVideo } from "@/lib/hr/training/video";
import {
  buildHomeNotifications,
  dismissHomeNotification,
  trainingOutstandingKey,
} from "@/lib/hr/home-notifications";
import {
  isSchedulingEligible,
  SchedulingIneligibleError,
} from "@/lib/hr/scheduling-eligibility";
import { saveAvailabilityWeek } from "@/lib/hr/availability";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture, type AdminHrFixture } from "../admin-workflows/_helpers";
import type { EmployeePortalPrincipal } from "@/lib/employee-portal-session";

const FAKE_VIDEO = Buffer.from(new Array(1024).fill(0));
const MONDAY = new Date(Date.UTC(2026, 7, 24));

async function makeEmployeeAndActor(fx: AdminHrFixture) {
  const emp = await prisma.employee.create({
    data: {
      clubId: fx.club.id,
      employeeNumber: `E-${Math.floor(Math.random() * 90000 + 10000)}`,
      firstName: "Test", lastName: "Emp",
      personalEmail: `t-${Date.now()}-${Math.floor(Math.random() * 9999)}@x.test`,
    },
  });
  const actor: EmployeePortalPrincipal = {
    employeeId: emp.id,
    clubId: emp.clubId,
    generation: 1,
    establishedAt: new Date().toISOString(),
  };
  return { employeeId: emp.id, actor };
}

async function publishCourse(fx: AdminHrFixture, code: string): Promise<string> {
  const { versionId } = await createCourse(fx.clubAdmin, fx.club.id, {
    code, title: "Safety Course", category: "Safety",
    version1Defaults: { required: true, appliesToAll: true },
  });
  await updateDraft(fx.clubAdmin, versionId, {
    appliesToAll: true, requiresKnowledgeTest: true,
  });
  await uploadTrainingVideo(fx.clubAdmin, versionId, {
    bytes: FAKE_VIDEO, mimeType: "video/mp4", durationSec: 60,
  });
  await createQuestion(fx.clubAdmin, versionId, {
    prompt: "Report a hazard when?",
    options: [
      { text: "End of shift", isCorrect: false },
      { text: "Immediately", isCorrect: true },
    ],
  });
  await publishDraft(fx.clubAdmin, versionId);
  return versionId;
}

describe("HR-2C Home refinement · notifications + dismissal", () => {
  let fx: AdminHrFixture;

  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
    fx = await makeAdminHrFixture("HR2CHome");
  });

  it("no applicable required training → no notifications", async () => {
    const { actor } = await makeEmployeeAndActor(fx);
    const nots = await buildHomeNotifications(actor);
    expect(nots).toHaveLength(0);
  });

  it("one outstanding required course → warning bar with actionable copy + dismissal key", async () => {
    await publishCourse(fx, "TRAINING_A_11111");
    const { actor } = await makeEmployeeAndActor(fx);
    const nots = await buildHomeNotifications(actor);
    expect(nots).toHaveLength(1);
    const n = nots[0]!;
    expect(n.kind).toBe("training_outstanding");
    expect(n.tone).toBe("warning");
    expect(n.dismissed).toBe(false);
    expect(n.actionLabel).toBe("Go to Training");
    expect(n.actionHref).toBe("/employee/safety-training");
    // Dismissal key encodes the state, not a generic identifier.
    expect(n.key).toMatch(/^training-outstanding:v1:[0-9a-f]{16}$/);
    // Message is display-safe — no course code / version id / enum leaks.
    const payload = JSON.stringify(n);
    expect(payload).not.toContain("TRAINING_A_11111");
    expect(payload).not.toContain("courseVersionId");
  });

  it("dismissal persists across builds AND does not affect eligibility (§3)", async () => {
    const versionId = await publishCourse(fx, "TRAINING_B_22222");
    const { actor, employeeId } = await makeEmployeeAndActor(fx);
    const nots = await buildHomeNotifications(actor);
    const key = nots[0]!.key;

    // Pre-dismissal: employee ineligible, availability write refused,
    // safety-training still shows the outstanding course.
    expect(await isSchedulingEligible(employeeId)).toBe(false);
    await expect(
      saveAvailabilityWeek(actor, { weekStart: MONDAY, monday: true }),
    ).rejects.toBeInstanceOf(SchedulingIneligibleError);

    // Dismiss.
    await dismissHomeNotification(actor, key);

    // Re-build — the bar shows as dismissed. Underlying state untouched.
    const after = await buildHomeNotifications(actor);
    expect(after).toHaveLength(1);
    expect(after[0]!.dismissed).toBe(true);
    expect(after[0]!.key).toBe(key);

    // Eligibility unchanged. Availability write still refused.
    // Outstanding-training list untouched. No TrainingCompletion created.
    expect(await isSchedulingEligible(employeeId)).toBe(false);
    await expect(
      saveAvailabilityWeek(actor, { weekStart: MONDAY, monday: true }),
    ).rejects.toBeInstanceOf(SchedulingIneligibleError);
    const completions = await prisma.trainingCompletion.count({
      where: { employeeId, courseVersionId: versionId },
    });
    expect(completions).toBe(0);
  });

  it("dismissal is idempotent (upsert)", async () => {
    await publishCourse(fx, "TRAINING_C_33333");
    const { actor, employeeId } = await makeEmployeeAndActor(fx);
    const nots = await buildHomeNotifications(actor);
    const key = nots[0]!.key;
    await dismissHomeNotification(actor, key);
    await dismissHomeNotification(actor, key);
    const count = await prisma.employeeHomeNotificationDismissal.count({
      where: { employeeId, notificationKey: key },
    });
    expect(count).toBe(1);
  });

  it("new required course → new notificationKey → bar resurfaces even though prior dismissal row still exists (§3 example)", async () => {
    await publishCourse(fx, "TRAINING_D_44444");
    const { actor, employeeId } = await makeEmployeeAndActor(fx);
    const first = await buildHomeNotifications(actor);
    const firstKey = first[0]!.key;
    await dismissHomeNotification(actor, firstKey);
    expect((await buildHomeNotifications(actor))[0]!.dismissed).toBe(true);

    // Admin publishes a SECOND applicable required course. This
    // changes the outstanding set → the notificationKey MUST change.
    await publishCourse(fx, "TRAINING_D_55555");
    const second = await buildHomeNotifications(actor);
    expect(second).toHaveLength(1);
    expect(second[0]!.key).not.toBe(firstKey);
    expect(second[0]!.dismissed).toBe(false); // new key → not dismissed

    // Prior dismissal row survives.
    const stillThere = await prisma.employeeHomeNotificationDismissal.findFirst({
      where: { employeeId, notificationKey: firstKey },
    });
    expect(stillThere).not.toBeNull();
  });

  it("trainingOutstandingKey is stable regardless of input order", () => {
    const a = trainingOutstandingKey(["v3", "v1", "v2"]);
    const b = trainingOutstandingKey(["v1", "v2", "v3"]);
    const c = trainingOutstandingKey(["v2", "v3", "v1"]);
    expect(a).toBe(b);
    expect(a).toBe(c);
    // Different set → different key.
    expect(trainingOutstandingKey(["v1", "v2"])).not.toBe(a);
  });

  it("optional courses NEVER produce a notification (§12 canonical eligibility respected)", async () => {
    // Publish an OPTIONAL applicable course.
    const { versionId } = await createCourse(fx.clubAdmin, fx.club.id, {
      code: "TRAINING_OPT_66666", title: "Optional Course", category: "Safety",
      version1Defaults: { required: false, appliesToAll: true },
    });
    await updateDraft(fx.clubAdmin, versionId, {
      appliesToAll: true, requiresKnowledgeTest: true,
    });
    await uploadTrainingVideo(fx.clubAdmin, versionId, {
      bytes: FAKE_VIDEO, mimeType: "video/mp4", durationSec: 60,
    });
    await createQuestion(fx.clubAdmin, versionId, {
      prompt: "Report a hazard when?",
      options: [
        { text: "End of shift", isCorrect: false },
        { text: "Immediately", isCorrect: true },
      ],
    });
    await publishDraft(fx.clubAdmin, versionId);
    const { actor } = await makeEmployeeAndActor(fx);
    const nots = await buildHomeNotifications(actor);
    expect(nots).toHaveLength(0);
  });
});
