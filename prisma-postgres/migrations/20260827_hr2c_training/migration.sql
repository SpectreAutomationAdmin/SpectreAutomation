-- HR-2C (2026-08-20) — Safety & Training compliance
--
-- Nine tables. Additive-only. No back-fill.
-- See prisma-postgres/schema.prisma for the full documentation.

CREATE TABLE "TrainingCourse" (
  "id"                TEXT NOT NULL PRIMARY KEY,
  "clubId"            TEXT NOT NULL,
  "code"              TEXT NOT NULL,
  "title"             TEXT NOT NULL,
  "category"          TEXT NOT NULL,
  "description"       TEXT,
  "retiredAt"         TIMESTAMP(3),
  "createdByUserId"   TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  "currentVersionId"  TEXT,
  CONSTRAINT "TrainingCourse_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TrainingCourse_clubId_code_key" ON "TrainingCourse"("clubId", "code");
CREATE INDEX "TrainingCourse_clubId_idx" ON "TrainingCourse"("clubId");
CREATE INDEX "TrainingCourse_clubId_category_idx" ON "TrainingCourse"("clubId", "category");

CREATE TABLE "TrainingCourseVersion" (
  "id"                    TEXT NOT NULL PRIMARY KEY,
  "courseId"              TEXT NOT NULL,
  "version"               INTEGER NOT NULL,
  "state"                 TEXT NOT NULL DEFAULT 'DRAFT',
  "title"                 TEXT NOT NULL,
  "description"           TEXT,
  "passingScore"          INTEGER NOT NULL DEFAULT 80,
  "retakesAllowed"        BOOLEAN NOT NULL DEFAULT true,
  "requiresKnowledgeTest" BOOLEAN NOT NULL DEFAULT true,
  "videoStorageKey"       TEXT,
  "videoMimeType"         TEXT,
  "videoSizeBytes"        INTEGER,
  "videoSha256"           TEXT,
  "videoDurationSec"      INTEGER,
  "appliesToAll"          BOOLEAN NOT NULL DEFAULT false,
  "appliesToDeptIds"      TEXT,
  "appliesToPositionIds"  TEXT,
  "required"              BOOLEAN NOT NULL DEFAULT true,
  "publishedAt"           TIMESTAMP(3),
  "publishedByUserId"     TEXT,
  "retiredAt"             TIMESTAMP(3),
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TrainingCourseVersion_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "TrainingCourse"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TrainingCourseVersion_courseId_version_key" ON "TrainingCourseVersion"("courseId", "version");
CREATE INDEX "TrainingCourseVersion_state_idx" ON "TrainingCourseVersion"("state");
CREATE INDEX "TrainingCourseVersion_courseId_state_idx" ON "TrainingCourseVersion"("courseId", "state");

CREATE TABLE "TrainingQuestion" (
  "id"              TEXT NOT NULL PRIMARY KEY,
  "courseVersionId" TEXT NOT NULL,
  "prompt"          TEXT NOT NULL,
  "displayOrder"    INTEGER NOT NULL DEFAULT 0,
  "active"          BOOLEAN NOT NULL DEFAULT true,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TrainingQuestion_courseVersionId_fkey"
    FOREIGN KEY ("courseVersionId") REFERENCES "TrainingCourseVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "TrainingQuestion_courseVersionId_displayOrder_idx" ON "TrainingQuestion"("courseVersionId", "displayOrder");

CREATE TABLE "TrainingAnswerOption" (
  "id"            TEXT NOT NULL PRIMARY KEY,
  "questionId"    TEXT NOT NULL,
  "text"          TEXT NOT NULL,
  "isCorrect"     BOOLEAN NOT NULL DEFAULT false,
  "displayOrder"  INTEGER NOT NULL DEFAULT 0,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TrainingAnswerOption_questionId_fkey"
    FOREIGN KEY ("questionId") REFERENCES "TrainingQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "TrainingAnswerOption_questionId_displayOrder_idx" ON "TrainingAnswerOption"("questionId", "displayOrder");

CREATE TABLE "TrainingAssignment" (
  "id"                TEXT NOT NULL PRIMARY KEY,
  "clubId"            TEXT NOT NULL,
  "employeeId"        TEXT NOT NULL,
  "courseId"          TEXT NOT NULL,
  "assignedByUserId"  TEXT,
  "assignedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "note"              TEXT,
  CONSTRAINT "TrainingAssignment_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TrainingAssignment_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TrainingAssignment_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "TrainingCourse"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TrainingAssignment_clubId_employeeId_courseId_key" ON "TrainingAssignment"("clubId", "employeeId", "courseId");
CREATE INDEX "TrainingAssignment_clubId_employeeId_idx" ON "TrainingAssignment"("clubId", "employeeId");
CREATE INDEX "TrainingAssignment_clubId_courseId_idx" ON "TrainingAssignment"("clubId", "courseId");

CREATE TABLE "TrainingProgress" (
  "id"              TEXT NOT NULL PRIMARY KEY,
  "clubId"          TEXT NOT NULL,
  "employeeId"      TEXT NOT NULL,
  "courseVersionId" TEXT NOT NULL,
  "secondsWatched"  INTEGER NOT NULL DEFAULT 0,
  "farthestSecond"  INTEGER NOT NULL DEFAULT 0,
  "percentComplete" INTEGER NOT NULL DEFAULT 0,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TrainingProgress_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TrainingProgress_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TrainingProgress_courseVersionId_fkey"
    FOREIGN KEY ("courseVersionId") REFERENCES "TrainingCourseVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TrainingProgress_employeeId_courseVersionId_key" ON "TrainingProgress"("employeeId", "courseVersionId");
CREATE INDEX "TrainingProgress_clubId_employeeId_idx" ON "TrainingProgress"("clubId", "employeeId");

CREATE TABLE "TrainingAttempt" (
  "id"              TEXT NOT NULL PRIMARY KEY,
  "clubId"          TEXT NOT NULL,
  "employeeId"      TEXT NOT NULL,
  "courseVersionId" TEXT NOT NULL,
  "attemptNumber"   INTEGER NOT NULL,
  "score"           INTEGER NOT NULL DEFAULT 0,
  "passed"          BOOLEAN NOT NULL DEFAULT false,
  "startedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "submittedAt"     TIMESTAMP(3),
  CONSTRAINT "TrainingAttempt_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TrainingAttempt_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TrainingAttempt_courseVersionId_fkey"
    FOREIGN KEY ("courseVersionId") REFERENCES "TrainingCourseVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TrainingAttempt_employeeId_courseVersionId_attemptNumber_key" ON "TrainingAttempt"("employeeId", "courseVersionId", "attemptNumber");
CREATE INDEX "TrainingAttempt_clubId_employeeId_idx" ON "TrainingAttempt"("clubId", "employeeId");
CREATE INDEX "TrainingAttempt_courseVersionId_passed_idx" ON "TrainingAttempt"("courseVersionId", "passed");

CREATE TABLE "TrainingQuestionResponse" (
  "id"                TEXT NOT NULL PRIMARY KEY,
  "attemptId"         TEXT NOT NULL,
  "questionId"        TEXT NOT NULL,
  "selectedOptionId"  TEXT NOT NULL,
  "wasCorrect"        BOOLEAN NOT NULL DEFAULT false,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TrainingQuestionResponse_attemptId_fkey"
    FOREIGN KEY ("attemptId") REFERENCES "TrainingAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TrainingQuestionResponse_questionId_fkey"
    FOREIGN KEY ("questionId") REFERENCES "TrainingQuestion"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TrainingQuestionResponse_selectedOptionId_fkey"
    FOREIGN KEY ("selectedOptionId") REFERENCES "TrainingAnswerOption"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TrainingQuestionResponse_attemptId_questionId_key" ON "TrainingQuestionResponse"("attemptId", "questionId");
CREATE INDEX "TrainingQuestionResponse_attemptId_idx" ON "TrainingQuestionResponse"("attemptId");

CREATE TABLE "TrainingCompletion" (
  "id"              TEXT NOT NULL PRIMARY KEY,
  "clubId"          TEXT NOT NULL,
  "employeeId"      TEXT NOT NULL,
  "courseId"        TEXT NOT NULL,
  "courseVersionId" TEXT NOT NULL,
  "attemptId"       TEXT NOT NULL,
  "score"           INTEGER NOT NULL,
  "completedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TrainingCompletion_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TrainingCompletion_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TrainingCompletion_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "TrainingCourse"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TrainingCompletion_courseVersionId_fkey"
    FOREIGN KEY ("courseVersionId") REFERENCES "TrainingCourseVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TrainingCompletion_attemptId_fkey"
    FOREIGN KEY ("attemptId") REFERENCES "TrainingAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TrainingCompletion_attemptId_key" ON "TrainingCompletion"("attemptId");
CREATE UNIQUE INDEX "TrainingCompletion_employeeId_courseVersionId_key" ON "TrainingCompletion"("employeeId", "courseVersionId");
CREATE INDEX "TrainingCompletion_clubId_employeeId_idx" ON "TrainingCompletion"("clubId", "employeeId");
CREATE INDEX "TrainingCompletion_clubId_courseId_idx" ON "TrainingCompletion"("clubId", "courseId");
CREATE INDEX "TrainingCompletion_employeeId_courseId_idx" ON "TrainingCompletion"("employeeId", "courseId");
