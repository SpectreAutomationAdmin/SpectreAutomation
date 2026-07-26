-- CreateTable
CREATE TABLE "Club" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "wordmark" TEXT,
    "logoUrl" TEXT,
    "primaryColor" TEXT NOT NULL DEFAULT '#2f5832',
    "whitelabelEnabled" BOOLEAN NOT NULL DEFAULT true,
    "address" TEXT,
    "region" TEXT,
    "salesTaxRegion" TEXT,
    "foundedYear" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Club_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubProfile" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "legalName" TEXT,
    "operatingName" TEXT,
    "yearFounded" INTEGER,
    "businessNumber" TEXT,
    "gstNumber" TEXT,
    "fiscalYearEndMonth" INTEGER,
    "fiscalYearEndDay" INTEGER,
    "mailingAddress" TEXT,
    "physicalAddress" TEXT,
    "city" TEXT,
    "provinceState" TEXT,
    "mainPhone" TEXT,
    "generalEmail" TEXT,
    "websiteUrl" TEXT,
    "primaryContactName" TEXT,
    "primaryContactTitle" TEXT,
    "primaryContactEmail" TEXT,
    "primaryContactPhone" TEXT,
    "gstStatus" TEXT,
    "gstFilingFrequency" TEXT,
    "defaultGstRatePct" DECIMAL(65,30),
    "defaultCurrency" TEXT,
    "equityBenchmarkBestCagrBps" INTEGER,
    "equityBenchmarkMinCagrBps" INTEGER,
    "defaultArAccountId" TEXT,
    "defaultApAccountId" TEXT,
    "defaultRetainedEarningsAccountId" TEXT,
    "defaultCurrentYearEarningsAccountId" TEXT,
    "defaultOperatingBankAccountId" TEXT,
    "defaultReserveBankAccountId" TEXT,
    "defaultMemberReceivablesAccountId" TEXT,
    "defaultSalesTaxPayableAccountId" TEXT,
    "updatedByUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClubProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "emailVerifiedAt" TIMESTAMP(3),
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mfaSecret" TEXT,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "lastLoginIp" TEXT,
    "memberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Permission" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "roleKey" TEXT NOT NULL,
    "permissionKey" TEXT NOT NULL,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("roleKey","permissionKey")
);

-- CreateTable
CREATE TABLE "UserClubRole" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clubId" TEXT,
    "roleKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserClubRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "beforeJson" TEXT,
    "afterJson" TEXT,
    "metaJson" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Applicant" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "sponsorName" TEXT,
    "membershipCategory" TEXT,
    "employmentInfo" TEXT,
    "address1" TEXT,
    "address2" TEXT,
    "city" TEXT,
    "provinceState" TEXT,
    "postalCode" TEXT,
    "country" TEXT,
    "dateOfBirth" TIMESTAMP(3),
    "referralSource" TEXT,
    "consentCreditCheck" BOOLEAN NOT NULL DEFAULT false,
    "consentBackgroundCheck" BOOLEAN NOT NULL DEFAULT false,
    "applicationStatus" TEXT NOT NULL DEFAULT 'DRAFT',
    "creditScoreBand" TEXT,
    "internalNotes" TEXT,
    "denialReason" TEXT,
    "pendingInfoNote" TEXT,
    "applicationFeeAmount" DOUBLE PRECISION,
    "applicationFeePaidAt" TIMESTAMP(3),
    "applicationFeeRef" TEXT,
    "reviewerId" TEXT,
    "waitlistPriority" INTEGER,
    "submittedAt" TIMESTAMP(3),
    "signedSubmissionIp" TEXT,
    "signedSubmissionUa" TEXT,
    "lastReviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Applicant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationHouseholdMember" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "relationship" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "dateOfBirth" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApplicationHouseholdMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationDocument" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedByUserId" TEXT,
    "accessTokenSecret" TEXT NOT NULL,

    CONSTRAINT "ApplicationDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationDraftToken" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApplicationDraftToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Member" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "applicantId" TEXT,
    "memberNumber" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "dateOfBirth" TIMESTAMP(3),
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "country" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ONBOARDING',
    "joinDate" TIMESTAMP(3),
    "membershipCategory" TEXT,
    "paymentMethodStatus" TEXT NOT NULL DEFAULT 'NONE',
    "accessStatus" TEXT NOT NULL DEFAULT 'FULL_ACCESS',
    "onboardingStartedAt" TIMESTAMP(3),
    "onboardingCompletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberAccount" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "currentBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "thirtyDayBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sixtyDayBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ninetyDayBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "oneTwentyDayBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "creditBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lastPaymentDate" TIMESTAMP(3),
    "lastRecomputedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Charge" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "transactionDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "postedByUserId" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedByUserId" TEXT,
    "voidReason" TEXT,
    "reversesId" TEXT,

    CONSTRAINT "Charge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "paymentDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "method" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUCCESS',
    "failureReason" TEXT,
    "paymentMethodId" TEXT,
    "processorRef" TEXT,
    "retryOfId" TEXT,
    "reversesId" TEXT,
    "postedByUserId" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedByUserId" TEXT,
    "voidReason" TEXT,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentMethod" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "brand" TEXT,
    "nickname" TEXT,
    "lastFour" TEXT,
    "expiryMonth" INTEGER,
    "expiryYear" INTEGER,
    "processorToken" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "isBackup" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastFailedAt" TIMESTAMP(3),
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentMethod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancingAgreement" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "agreementNumber" TEXT,
    "principalAmount" DOUBLE PRECISION NOT NULL,
    "interestRate" DOUBLE PRECISION NOT NULL,
    "termMonths" INTEGER NOT NULL,
    "paymentFrequency" TEXT NOT NULL DEFAULT 'MONTHLY',
    "monthlyPayment" DOUBLE PRECISION NOT NULL,
    "totalInterest" DOUBLE PRECISION NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "prepaymentAllowed" BOOLEAN NOT NULL DEFAULT true,
    "paidOffAt" TIMESTAMP(3),
    "defaultedAt" TIMESTAMP(3),
    "signedAt" TIMESTAMP(3),
    "signatureName" TEXT,
    "signedIp" TEXT,
    "signedUa" TEXT,
    "currentDocumentId" TEXT,

    CONSTRAINT "FinancingAgreement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancingDocument" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "agreementId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "storageKey" TEXT,
    "contentHash" TEXT,
    "renderedJson" TEXT NOT NULL,
    "signedAt" TIMESTAMP(3),
    "signatureName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinancingDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancingPayment" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "agreementId" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "amountApplied" DOUBLE PRECISION NOT NULL,
    "principalApplied" DOUBLE PRECISION NOT NULL,
    "interestApplied" DOUBLE PRECISION NOT NULL,
    "paymentDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinancingPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancingPaymentSchedule" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "financingAgreementId" TEXT NOT NULL,
    "paymentNumber" INTEGER NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "paymentAmount" DOUBLE PRECISION NOT NULL,
    "principalAmount" DOUBLE PRECISION NOT NULL,
    "interestAmount" DOUBLE PRECISION NOT NULL,
    "remainingBalance" DOUBLE PRECISION NOT NULL,
    "amountPaid" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',

    CONSTRAINT "FinancingPaymentSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionNotice" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "noticeType" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "templateId" TEXT,
    "stageKey" TEXT,

    CONSTRAINT "CollectionNotice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionNoticeTemplate" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionNoticeTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionStage" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "triggerAgeDays" INTEGER NOT NULL,
    "defaultTemplateKey" TEXT,
    "autoSuspendChargeAccount" BOOLEAN NOT NULL DEFAULT false,
    "autoSuspendTeeSheet" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollectionStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionAction" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "stageId" TEXT,
    "action" TEXT NOT NULL,
    "meta" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubMilestone" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "mediaUrl" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ClubMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberPreference" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "interestedGolf" BOOLEAN NOT NULL DEFAULT false,
    "interestedDining" BOOLEAN NOT NULL DEFAULT false,
    "interestedEvents" BOOLEAN NOT NULL DEFAULT false,
    "interestedLeagues" BOOLEAN NOT NULL DEFAULT false,
    "interestedPracticeFacilities" BOOLEAN NOT NULL DEFAULT false,
    "wantsProShopOffers" BOOLEAN NOT NULL DEFAULT false,
    "wantsTeeTimeAlerts" BOOLEAN NOT NULL DEFAULT false,
    "emailStatements" BOOLEAN NOT NULL DEFAULT true,
    "emailAccountAlerts" BOOLEAN NOT NULL DEFAULT true,
    "emailEventAnnouncements" BOOLEAN NOT NULL DEFAULT true,
    "emailGeneralAnnouncements" BOOLEAN NOT NULL DEFAULT true,
    "smsPaymentAlerts" BOOLEAN NOT NULL DEFAULT false,
    "smsTeeTimeAlerts" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DashboardWidget" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "widgetType" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "size" TEXT NOT NULL DEFAULT 'DETAILED',

    CONSTRAINT "DashboardWidget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubEvent" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "eventDate" TIMESTAMP(3) NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 0,
    "price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PUBLISHED',

    CONSTRAINT "ClubEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventRegistration" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REGISTERED',
    "numberOfGuests" INTEGER NOT NULL DEFAULT 0,
    "amountCharged" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnboardingChecklistItem" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "completedAt" TIMESTAMP(3),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OnboardingChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncentiveCredit" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "appliedTo" TEXT NOT NULL DEFAULT 'NONE_YET',
    "appliedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncentiveCredit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubWidgetConfig" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "widgetType" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ClubWidgetConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberHouseholdMember" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "relationship" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "dateOfBirth" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberHouseholdMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberDocument" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "storageKey" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "metaJson" TEXT,
    "visibleToMember" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubAnnouncement" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "audience" TEXT NOT NULL DEFAULT 'ALL_MEMBERS',
    "publishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubAnnouncement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountAdjustment" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT,
    "transactionDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "postedByUserId" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedByUserId" TEXT,
    "voidReason" TEXT,

    CONSTRAINT "AccountAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountNote" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "authorUserId" TEXT,
    "body" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentPromise" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "promisedAmount" DOUBLE PRECISION NOT NULL,
    "promisedDate" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "recordedByUserId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentPromise_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dispute" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "chargeId" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolution" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Statement" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "openingBalance" DOUBLE PRECISION NOT NULL,
    "closingBalance" DOUBLE PRECISION NOT NULL,
    "totalCharges" DOUBLE PRECISION NOT NULL,
    "totalPayments" DOUBLE PRECISION NOT NULL,
    "totalAdjustments" DOUBLE PRECISION NOT NULL,
    "agingCurrent" DOUBLE PRECISION NOT NULL,
    "aging30" DOUBLE PRECISION NOT NULL,
    "aging60" DOUBLE PRECISION NOT NULL,
    "aging90" DOUBLE PRECISION NOT NULL,
    "aging120" DOUBLE PRECISION NOT NULL,
    "linesJson" TEXT NOT NULL,
    "messageBody" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedByUserId" TEXT,

    CONSTRAINT "Statement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Department" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "parentDepartmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostCenter" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "departmentId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CostCenter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancialStatementGroup" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "cashFlowSection" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "parentGroupId" TEXT,

    CONSTRAINT "FinancialStatementGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountCategory" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AccountCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "normalBalance" TEXT NOT NULL,
    "categoryId" TEXT,
    "parentAccountId" TEXT,
    "isHeader" BOOLEAN NOT NULL DEFAULT false,
    "allowManualPosting" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isTaxRelevant" BOOLEAN NOT NULL DEFAULT false,
    "isBankAccount" BOOLEAN NOT NULL DEFAULT false,
    "isControlAccount" BOOLEAN NOT NULL DEFAULT false,
    "isCashAccount" BOOLEAN NOT NULL DEFAULT false,
    "fsGroupId" TEXT,
    "fundApplicability" TEXT,
    "defaultDepartmentId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountDepartment" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountDepartment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FiscalYear" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "closingEquity" DECIMAL(65,30),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FiscalYear_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FiscalPeriod" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "fiscalYearId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMP(3),
    "closedByUserId" TEXT,
    "closingNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closingNoi" DECIMAL(65,30),
    "closingRevenue" DECIMAL(65,30),
    "budgetNoi" DECIMAL(65,30),

    CONSTRAINT "FiscalPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalBatch" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "batchNumber" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "postedAt" TIMESTAMP(3),
    "postedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JournalBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "entryNumber" TEXT NOT NULL,
    "batchId" TEXT,
    "entryDate" TIMESTAMP(3) NOT NULL,
    "periodId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "memo" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "sourceEntityType" TEXT,
    "sourceEntityId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "approvedAt" TIMESTAMP(3),
    "approvedByUserId" TEXT,
    "postedAt" TIMESTAMP(3),
    "postedByUserId" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedByUserId" TEXT,
    "voidReason" TEXT,
    "reversesId" TEXT,
    "isAutoReversing" BOOLEAN NOT NULL DEFAULT false,
    "reverseOnDate" TIMESTAMP(3),
    "totalDebits" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "totalCredits" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntryLine" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "accountId" TEXT NOT NULL,
    "departmentId" TEXT,
    "costCenterId" TEXT,
    "debit" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "credit" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "description" TEXT,
    "memberId" TEXT,

    CONSTRAINT "JournalEntryLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurringJournal" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "frequency" TEXT NOT NULL,
    "nextRunDate" TIMESTAMP(3),
    "templateJson" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurringJournal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalAttachment" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "storageKey" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedByUserId" TEXT,

    CONSTRAINT "JournalAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vendor" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "vendorNumber" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "operatingName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "taxRegistrationNumber" TEXT,
    "taxRegion" TEXT,
    "defaultExpenseAccountId" TEXT,
    "defaultDepartmentId" TEXT,
    "defaultTaxCodeKey" TEXT,
    "paymentTermsDays" INTEGER NOT NULL DEFAULT 30,
    "paymentMethod" TEXT NOT NULL DEFAULT 'CHEQUE',
    "email" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "address1" TEXT,
    "address2" TEXT,
    "city" TEXT,
    "provinceState" TEXT,
    "postalCode" TEXT,
    "country" TEXT,
    "notes" TEXT,
    "blockedReason" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedByUserId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorContact" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorBankingProfile" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'EFT',
    "bankName" TEXT,
    "institutionNumber" TEXT,
    "transitNumber" TEXT,
    "accountLastFour" TEXT,
    "processorToken" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "approvedAt" TIMESTAMP(3),
    "approvedByUserId" TEXT,
    "rejectedReason" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "approvalRequestId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorBankingProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PennyTest" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "bankingProfileId" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "confirmedAmount" DECIMAL(65,30),
    "initiatedByUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "notes" TEXT,

    CONSTRAINT "PennyTest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorDocument" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "storageKey" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedByUserId" TEXT,

    CONSTRAINT "VendorDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorRiskFlag" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
    "description" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorRiskFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxCode" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "region" TEXT,
    "ratePct" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "recoverableAccountId" TEXT,
    "payableAccountId" TEXT,
    "isRecoverable" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalPolicy" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rulesJson" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "policyId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "requiredApprovals" INTEGER NOT NULL DEFAULT 1,
    "eligibleRoleKeys" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedByUserId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalDecision" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "comment" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "APInvoice" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "vendorReference" TEXT,
    "vendorId" TEXT NOT NULL,
    "invoiceDate" TIMESTAMP(3) NOT NULL,
    "dueDate" TIMESTAMP(3),
    "terms" TEXT,
    "description" TEXT,
    "departmentId" TEXT,
    "subtotal" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "total" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "amountPaid" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "approvalRequestId" TEXT,
    "postedAt" TIMESTAMP(3),
    "postedByUserId" TEXT,
    "postedJournalEntryId" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedByUserId" TEXT,
    "voidReason" TEXT,
    "reversingJournalEntryId" TEXT,
    "captureId" TEXT,
    "notes" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "APInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "APInvoiceLine" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "expenseAccountId" TEXT NOT NULL,
    "departmentId" TEXT,
    "costCenterId" TEXT,
    "description" TEXT,
    "quantity" DECIMAL(65,30) DEFAULT 1,
    "unitCost" DECIMAL(65,30),
    "amount" DECIMAL(65,30) NOT NULL,
    "taxCodeId" TEXT,
    "taxAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "isCapital" BOOLEAN NOT NULL DEFAULT false,
    "isInventory" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "APInvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "APInvoiceAttachment" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "storageKey" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedByUserId" TEXT,

    CONSTRAINT "APInvoiceAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptCapture" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "storageKey" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "extractedJson" TEXT,
    "suggestionJson" TEXT,
    "confidence" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "duplicateOfInvoiceId" TEXT,
    "convertedAt" TIMESTAMP(3),
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedByUserId" TEXT,

    CONSTRAINT "ReceiptCapture_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentBatch" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "batchNumber" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "paymentDate" TIMESTAMP(3) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "bankAccountId" TEXT,
    "paymentMethod" TEXT NOT NULL DEFAULT 'EFT',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "approvalRequestId" TEXT,
    "totalAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "processedAt" TIMESTAMP(3),
    "processedByUserId" TEXT,
    "exportedAt" TIMESTAMP(3),
    "exportFileRef" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentBatchItem" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "paymentId" TEXT,

    CONSTRAINT "PaymentBatchItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorPayment" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "batchId" TEXT,
    "paymentNumber" TEXT NOT NULL,
    "paymentDate" TIMESTAMP(3) NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'EFT',
    "amount" DECIMAL(65,30) NOT NULL,
    "processorRef" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "postedJournalEntryId" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedByUserId" TEXT,
    "voidReason" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "APException" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "vendorId" TEXT,
    "captureId" TEXT,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolutionNote" TEXT,
    "overrideByUserId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "APException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryCategory" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "inventoryAccountId" TEXT,
    "cogsAccountId" TEXT,
    "revenueAccountId" TEXT,
    "adjustmentExpenseAccountId" TEXT,
    "defaultTaxCodeKey" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryLocation" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "departmentId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryItem" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "upc" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "brand" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'STANDARD',
    "categoryId" TEXT,
    "preferredVendorId" TEXT,
    "defaultLocationId" TEXT,
    "unitOfMeasure" TEXT NOT NULL DEFAULT 'EA',
    "defaultCost" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "retailPrice" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "averageCost" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "quantityOnHand" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "quantityCommitted" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "reorderPoint" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "reorderQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "taxCodeKey" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isEcommerce" BOOLEAN NOT NULL DEFAULT false,
    "imageStorageKey" TEXT,
    "inventoryAccountId" TEXT,
    "cogsAccountId" TEXT,
    "revenueAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryTransaction" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "locationId" TEXT,
    "kind" TEXT NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,
    "unitCost" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "totalCost" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "averageCostAfter" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "quantityAfter" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "transactionDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "postedJournalEntryId" TEXT,
    "notes" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryAdjustment" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "locationId" TEXT,
    "quantityChange" DECIMAL(65,30) NOT NULL,
    "unitCost" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "reasonCode" TEXT NOT NULL,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postedByUserId" TEXT,

    CONSTRAINT "InventoryAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryCount" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "countNumber" TEXT NOT NULL,
    "locationId" TEXT,
    "description" TEXT,
    "countDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "postedAt" TIMESTAMP(3),
    "postedByUserId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryCount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryCountLine" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "countId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "systemQty" DECIMAL(65,30) NOT NULL,
    "countedQty" DECIMAL(65,30),
    "varianceQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "varianceCost" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "notes" TEXT,

    CONSTRAINT "InventoryCountLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryReceiving" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "receivingNumber" TEXT NOT NULL,
    "vendorId" TEXT,
    "locationId" TEXT,
    "receivedDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "totalReceivedCost" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "matchedApInvoiceId" TEXT,
    "postedAt" TIMESTAMP(3),
    "postedByUserId" TEXT,
    "postedJournalEntryId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryReceiving_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryReceivingLine" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "receivingId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,
    "unitCost" DECIMAL(65,30) NOT NULL,
    "totalCost" DECIMAL(65,30) NOT NULL,
    "notes" TEXT,

    CONSTRAINT "InventoryReceivingLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryTransfer" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "transferNumber" TEXT NOT NULL,
    "fromLocationId" TEXT NOT NULL,
    "toLocationId" TEXT NOT NULL,
    "transferDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "postedAt" TIMESTAMP(3),
    "postedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryTransferLine" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,
    "unitCost" DECIMAL(65,30) NOT NULL,

    CONSTRAINT "InventoryTransferLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventCategory" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "defaultRevenueAccountId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrivateEventInquiry" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "inquirerName" TEXT NOT NULL,
    "inquirerEmail" TEXT,
    "inquirerPhone" TEXT,
    "preferredDate" TIMESTAMP(3),
    "headCount" INTEGER,
    "message" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "reviewedAt" TIMESTAMP(3),
    "reviewedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrivateEventInquiry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrivateEventBooking" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "bookingNumber" TEXT NOT NULL,
    "inquiryId" TEXT,
    "memberId" TEXT,
    "customerName" TEXT NOT NULL,
    "customerEmail" TEXT,
    "customerPhone" TEXT,
    "eventName" TEXT NOT NULL,
    "eventStart" TIMESTAMP(3) NOT NULL,
    "eventEnd" TIMESTAMP(3) NOT NULL,
    "headCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "depositAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "depositPaidAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "revenueAccountId" TEXT,
    "deferredRevenueAccountId" TEXT,
    "finalPostedJournalEntryId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrivateEventBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrivateEventDeposit" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "receivedDate" TIMESTAMP(3),
    "method" TEXT NOT NULL DEFAULT 'EFT',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "postedJournalEntryId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrivateEventDeposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrivateEventMenuSelection" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "course" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "pricePerHead" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "totalPrice" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "notes" TEXT,

    CONSTRAINT "PrivateEventMenuSelection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrivateEventBarSelection" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "pricePerHead" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "totalPrice" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "notes" TEXT,

    CONSTRAINT "PrivateEventBarSelection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrivateEventAddOn" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL DEFAULT 1,
    "unitPrice" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "totalPrice" DECIMAL(65,30) NOT NULL DEFAULT 0,

    CONSTRAINT "PrivateEventAddOn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GolfProfessional" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "userId" TEXT,
    "payoutVendorId" TEXT,
    "isHeadPro" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "hourlyRate" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GolfProfessional_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LessonType" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL DEFAULT 60,
    "memberPrice" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "instructorPayPerLesson" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "revenueAccountId" TEXT,
    "instructorExpenseAccountId" TEXT,
    "isGroup" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LessonType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LessonBooking" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "bookingNumber" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "lessonTypeId" TEXT NOT NULL,
    "instructorId" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "durationMinutes" INTEGER NOT NULL DEFAULT 60,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "instructorConfirmedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "headProApprovedAt" TIMESTAMP(3),
    "headProApprovedByUserId" TEXT,
    "cancellationReason" TEXT,
    "memberChargeId" TEXT,
    "accrualJournalEntryId" TEXT,
    "notes" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LessonBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LessonPayable" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "instructorId" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "accruedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidApInvoiceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACCRUED',
    "notes" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LessonPayable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeePosition" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "defaultPayRate" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "isExempt" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeePosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "employeeNumber" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "userId" TEXT,
    "departmentId" TEXT,
    "positionId" TEXT,
    "hireDate" TIMESTAMP(3),
    "terminationDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "compensationType" TEXT NOT NULL DEFAULT 'HOURLY',
    "payRate" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "payrollIdExternal" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollPeriod" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "payDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "lockedAt" TIMESTAMP(3),
    "lockedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Timesheet" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "approvedByUserId" TEXT,
    "totalHours" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "totalOvertimeHours" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Timesheet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimesheetEntry" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "timesheetId" TEXT NOT NULL,
    "workDate" TIMESTAMP(3) NOT NULL,
    "startTime" TIMESTAMP(3),
    "endTime" TIMESTAMP(3),
    "totalHours" DECIMAL(65,30) NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'REGULAR',
    "departmentId" TEXT,
    "sourceType" TEXT NOT NULL DEFAULT 'MANUAL',
    "notes" TEXT,

    CONSTRAINT "TimesheetEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeClockEvent" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "notes" TEXT,

    CONSTRAINT "TimeClockEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRun" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "runNumber" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "totalGross" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "totalNet" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "totalEmployerCost" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "totalTaxes" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "totalBenefits" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "postedAt" TIMESTAMP(3),
    "postedByUserId" TEXT,
    "postedJournalEntryId" TEXT,
    "approvalRequestId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollLine" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "departmentId" TEXT,
    "regularHours" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "overtimeHours" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "grossPay" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "taxes" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "benefits" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "netPay" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "deductionsJson" TEXT,
    "earningsJson" TEXT,

    CONSTRAINT "PayrollLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRemittance" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT,
    "amount" DECIMAL(65,30) NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "paidApInvoiceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollRemittance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabourBudget" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "departmentId" TEXT,
    "periodLabel" TEXT NOT NULL,
    "budgetedHours" DECIMAL(65,30) NOT NULL,
    "budgetedCost" DECIMAL(65,30) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LabourBudget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetCategory" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "assetAccountId" TEXT,
    "accumulatedDepreciationAccountId" TEXT,
    "depreciationExpenseAccountId" TEXT,
    "defaultUsefulLifeMonths" INTEGER NOT NULL DEFAULT 60,
    "defaultMethod" TEXT NOT NULL DEFAULT 'STRAIGHT_LINE',
    "defaultDecliningBalanceRate" DECIMAL(65,30),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetLocation" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "AssetLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapitalAsset" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "assetNumber" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "categoryId" TEXT,
    "locationId" TEXT,
    "departmentId" TEXT,
    "acquisitionDate" TIMESTAMP(3) NOT NULL,
    "acquisitionCost" DECIMAL(65,30) NOT NULL,
    "residualValue" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "usefulLifeMonths" INTEGER NOT NULL DEFAULT 60,
    "depreciationMethod" TEXT NOT NULL DEFAULT 'STRAIGHT_LINE',
    "decliningBalanceRate" DECIMAL(65,30),
    "accumulatedDepreciation" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "netBookValue" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "imageStorageKey" TEXT,
    "sourceApInvoiceId" TEXT,
    "acquisitionJournalEntryId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CapitalAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetDepreciationEntry" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "periodLabel" TEXT NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "accumulatedAfter" DECIMAL(65,30) NOT NULL,
    "postedJournalEntryId" TEXT,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postedByUserId" TEXT,

    CONSTRAINT "AssetDepreciationEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetMaintenanceRecord" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "performedAt" TIMESTAMP(3) NOT NULL,
    "performedBy" TEXT,
    "apInvoiceId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetMaintenanceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetDisposal" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "disposalDate" TIMESTAMP(3) NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'SALE',
    "proceeds" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "bookValueAtDisposal" DECIMAL(65,30) NOT NULL,
    "gainLoss" DECIMAL(65,30) NOT NULL,
    "notes" TEXT,
    "postedJournalEntryId" TEXT,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postedByUserId" TEXT,

    CONSTRAINT "AssetDisposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Budget" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "fiscalYearId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "description" TEXT,
    "approvalRequestId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetLine" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "departmentId" TEXT,
    "monthlyAmounts" TEXT NOT NULL,
    "annualTotal" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BudgetLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetAssumption" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BudgetAssumption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Forecast" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "fiscalYearId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "asOfDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "sourceBudgetId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Forecast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ForecastLine" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "forecastId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "departmentId" TEXT,
    "monthlyAmounts" TEXT NOT NULL,
    "totalAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "notes" TEXT,

    CONSTRAINT "ForecastLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportDefinition" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL DEFAULT 'OPERATING',
    "kind" TEXT NOT NULL DEFAULT 'BUILTIN',
    "parametersSchema" TEXT,
    "permissionKey" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedReport" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "parametersJson" TEXT NOT NULL,
    "ownerUserId" TEXT,
    "isShared" BOOLEAN NOT NULL DEFAULT false,
    "scheduleCron" TEXT,
    "lastRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportRun" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "savedReportId" TEXT,
    "parametersJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "resultJson" TEXT,
    "resultDocumentId" TEXT,
    "errorMessage" TEXT,
    "runByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportExport" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "reportRunId" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "documentId" TEXT,
    "storageKey" TEXT,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "exportedByUserId" TEXT,
    "exportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportExport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportingPackage" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "periodLabel" TEXT NOT NULL,
    "asOfDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "audience" TEXT NOT NULL DEFAULT 'BOARD',
    "executiveSummary" TEXT,
    "createdByUserId" TEXT,
    "finalizedAt" TIMESTAMP(3),
    "finalizedByUserId" TEXT,
    "approvalRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportingPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportingPackageSection" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "reportRunId" TEXT,
    "body" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'REPORT',

    CONSTRAINT "ReportingPackageSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportingPackageCommentary" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'GENERAL',
    "body" TEXT NOT NULL,
    "followUpDate" TIMESTAMP(3),
    "followUpOwnerUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "priorCommentaryId" TEXT,
    "authorUserId" TEXT,
    "finalizedAt" TIMESTAMP(3),
    "aiDraftId" TEXT,
    "isAIDraft" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportingPackageCommentary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackageDistribution" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "recipientName" TEXT NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "recipientUserId" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'EMAIL',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "sentAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "documentId" TEXT,

    CONSTRAINT "PackageDistribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackageApproval" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "approverUserId" TEXT NOT NULL,
    "approverRole" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedAt" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "PackageApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonthlyPackage" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "reportingYear" INTEGER NOT NULL,
    "reportingMonth" INTEGER NOT NULL,
    "periodEndDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generatedByUserId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "publishedByUserId" TEXT,
    "sentAt" TIMESTAMP(3),
    "sentByUserId" TEXT,
    "executiveOpeningSnapshotJson" TEXT,
    "atAGlanceKpisJson" TEXT,
    "packagePayloadJson" TEXT,
    "publishedPayloadHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonthlyPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonthlyPackageRecipient" (
    "id" TEXT NOT NULL,
    "monthlyPackageId" TEXT NOT NULL,
    "recipientUserId" TEXT,
    "recipientEmail" TEXT NOT NULL,
    "recipientRole" TEXT,
    "sentAt" TIMESTAMP(3),
    "viewedAt" TIMESTAMP(3),
    "deliveryStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonthlyPackageRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoardRole" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "roleTitle" TEXT NOT NULL,
    "committeeName" TEXT,
    "termStartDate" TIMESTAMP(3) NOT NULL,
    "termEndDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UPCOMING',
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BoardRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditorAccessGrant" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "auditorName" TEXT NOT NULL,
    "auditorEmail" TEXT NOT NULL,
    "firmName" TEXT,
    "invitedByUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "scopeJson" TEXT NOT NULL,
    "fiscalYearId" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "inviteToken" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditorAccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditorSession" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "ip" TEXT,
    "userAgent" TEXT,
    "activityCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AuditorSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditRequest" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "grantId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "requestedByUserId" TEXT,
    "assignedToUserId" TEXT,
    "dueDate" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuditRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditRequestItem" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "documentId" TEXT,
    "providedAt" TIMESTAMP(3),
    "providedByUserId" TEXT,

    CONSTRAINT "AuditRequestItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditExport" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "documentId" TEXT,
    "storageKey" TEXT,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "exportedByUserId" TEXT,
    "exportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditExport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "toUserId" TEXT,
    "toMemberId" TEXT,
    "toEmail" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'IN_APP',
    "templateKey" TEXT,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "metaJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "readAt" TIMESTAMP(3),
    "triggeredEntityType" TEXT,
    "triggeredEntityId" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationTemplate" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'EMAIL',
    "subjectTemplate" TEXT NOT NULL,
    "bodyTemplate" TEXT NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "userId" TEXT,
    "memberId" TEXT,
    "topic" TEXT NOT NULL,
    "channels" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "providerMessageId" TEXT,
    "failureReason" TEXT,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunicationLog" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "toAddress" TEXT,
    "toUserId" TEXT,
    "toMemberId" TEXT,
    "subject" TEXT,
    "bodySnippet" TEXT,
    "status" TEXT NOT NULL,
    "triggeredEntityType" TEXT,
    "triggeredEntityId" TEXT,
    "notificationId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunicationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunicationCampaign" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "templateKey" TEXT,
    "audienceJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "scheduledFor" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunicationCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "folderId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "storageKey" TEXT,
    "checksum" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "retentionPolicyId" TEXT,
    "retainedUntil" TIMESTAMP(3),
    "memberId" TEXT,
    "vendorId" TEXT,
    "apInvoiceId" TEXT,
    "journalEntryId" TEXT,
    "assetId" TEXT,
    "privateEventId" TEXT,
    "payrollRunId" TEXT,
    "financingAgreementId" TEXT,
    "reportingPackageId" TEXT,
    "auditRequestId" TEXT,
    "searchText" TEXT,
    "uploadedByUserId" TEXT,
    "isSoftDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentFolder" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentFolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentTag" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "color" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentTagJoin" (
    "documentId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    CONSTRAINT "DocumentTagJoin_pkey" PRIMARY KEY ("documentId","tagId")
);

-- CreateTable
CREATE TABLE "DocumentVersion" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "storageKey" TEXT,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "checksum" TEXT,
    "uploadedByUserId" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,

    CONSTRAINT "DocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentAccess" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'USER',
    "userId" TEXT,
    "roleKey" TEXT,
    "signedUrlToken" TEXT,
    "expiresAt" TIMESTAMP(3),
    "canDownload" BOOLEAN NOT NULL DEFAULT true,
    "grantedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentRetentionPolicy" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "retentionDays" INTEGER NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'ALL',
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentRetentionPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentAuditLog" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorAuditorGrantId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KPI" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL,
    "unit" TEXT,
    "computeKey" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'HIGHER_BETTER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KPI_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KPIValue" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "kpiId" TEXT NOT NULL,
    "periodLabel" TEXT NOT NULL,
    "asOfDate" TIMESTAMP(3) NOT NULL,
    "value" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "metaJson" TEXT,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KPIValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KPIDashboard" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "audience" TEXT NOT NULL DEFAULT 'INTERNAL',
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KPIDashboard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KPIWidget" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "dashboardId" TEXT NOT NULL,
    "kpiId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'STAT',
    "title" TEXT NOT NULL,
    "configJson" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "width" TEXT NOT NULL DEFAULT 'MD',

    CONSTRAINT "KPIWidget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KPIThreshold" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "kpiId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'WARNING',
    "op" TEXT NOT NULL,
    "threshold" DECIMAL(65,30) NOT NULL,
    "notifyRoleKey" TEXT,
    "notifyUserId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KPIThreshold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KPIAlert" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "kpiId" TEXT NOT NULL,
    "thresholdId" TEXT,
    "periodLabel" TEXT NOT NULL,
    "observedValue" DECIMAL(65,30) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "KPIAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workflow" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "currentStepId" TEXT,
    "createdByUserId" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowStep" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "kind" TEXT NOT NULL DEFAULT 'APPROVAL',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requiredApprovals" INTEGER NOT NULL DEFAULT 1,
    "approverRoleKey" TEXT,
    "approverUserId" TEXT,
    "dueAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "WorkflowStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowAssignment" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "stepId" TEXT,
    "assigneeUserId" TEXT,
    "assigneeRoleKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "dueAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowApproval" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "stepId" TEXT,
    "approverUserId" TEXT NOT NULL,
    "approverRoleKey" TEXT,
    "decision" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,

    CONSTRAINT "WorkflowApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowComment" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "authorUserId" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowHistory" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "byUserId" TEXT,
    "metaJson" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubSetting" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "valueJson" TEXT NOT NULL,
    "updatedByUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Insight" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "ruleId" TEXT,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'INFO',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "metaJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedByUserId" TEXT,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Insight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InsightRule" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'INFO',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "parametersJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InsightRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InsightAlert" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "ruleId" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'IN_APP',
    "notifyRoleKey" TEXT,
    "notifyUserId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InsightAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchIndexEntry" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "body" TEXT,
    "url" TEXT NOT NULL,
    "permissionKey" TEXT,
    "metaJson" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SearchIndexEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationSetting" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "configJson" TEXT NOT NULL,
    "secretsJson" TEXT,
    "lastTestedAt" TIMESTAMP(3),
    "lastTestStatus" TEXT,
    "lastTestError" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationCheck" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "settingId" TEXT,
    "scope" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkedByUserId" TEXT,

    CONSTRAINT "IntegrationCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentBackfillBatch" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "sourceTable" TEXT NOT NULL,
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "totalCandidates" INTEGER NOT NULL DEFAULT 0,
    "totalCreated" INTEGER NOT NULL DEFAULT 0,
    "totalSkipped" INTEGER NOT NULL DEFAULT 0,
    "totalFailed" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRY_RUN',
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "startedByUserId" TEXT,
    "reportJson" TEXT,

    CONSTRAINT "DocumentBackfillBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POSLocation" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "departmentId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "POSLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POSTerminal" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "providerId" TEXT,
    "externalReference" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "POSTerminal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POSSession" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "terminalId" TEXT,
    "openedByUserId" TEXT,
    "closedByUserId" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "openingFloat" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "closingFloat" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OPEN',

    CONSTRAINT "POSSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POSSale" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "saleNumber" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "terminalId" TEXT,
    "sessionId" TEXT,
    "memberId" TEXT,
    "guestName" TEXT,
    "departmentId" TEXT,
    "chargeMode" TEXT NOT NULL DEFAULT 'MEMBER_ACCOUNT',
    "diningMode" TEXT NOT NULL DEFAULT 'STAY',
    "subtotal" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "discountTotal" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "gratuityTotal" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "grandTotal" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "saleDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "providerId" TEXT,
    "externalReference" TEXT,
    "arChargeId" TEXT,
    "postedJournalEntryId" TEXT,
    "refundOfSaleId" TEXT,
    "notes" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "POSSale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POSSaleLine" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'OTHER',
    "itemId" TEXT,
    "menuItemId" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL DEFAULT 1,
    "unitPrice" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "unitCost" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "lineSubtotal" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "revenueAccountId" TEXT,
    "inventoryTransactionId" TEXT,

    CONSTRAINT "POSSaleLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POSTaxLine" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'TAX',
    "label" TEXT NOT NULL,
    "rate" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "amount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "taxCodeKey" TEXT,

    CONSTRAINT "POSTaxLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POSDiscount" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'AMOUNT',
    "label" TEXT NOT NULL,
    "value" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "amount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "notes" TEXT,

    CONSTRAINT "POSDiscount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POSMenuCategory" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "locationId" TEXT,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "chitDestination" TEXT NOT NULL DEFAULT 'KITCHEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "POSMenuCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POSMenuItem" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "taxable" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "POSMenuItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POSModifierGroup" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "modifierType" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "POSModifierGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POSModifierOption" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "printLabel" TEXT,
    "priceDelta" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "POSModifierOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POSCheckLineModifier" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "checkLineId" TEXT NOT NULL,
    "optionId" TEXT,
    "modifierType" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "printLabel" TEXT,
    "priceDelta" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "POSCheckLineModifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POSPrinter" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'ANY',
    "kind" TEXT NOT NULL DEFAULT 'PDF',
    "location" TEXT,
    "driverHint" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "POSPrinter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POSSaleChit" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "pdfBytes" BYTEA NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "POSSaleChit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POSSaleLineModifier" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "saleLineId" TEXT NOT NULL,
    "modifierType" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "printLabel" TEXT,
    "priceDelta" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "POSSaleLineModifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POSPayment" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "tipAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'CAPTURED',
    "externalReference" TEXT,
    "processorToken" TEXT,
    "externalPaymentStatus" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "POSPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POSCheck" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "terminalId" TEXT,
    "sessionId" TEXT,
    "memberId" TEXT,
    "guestName" TEXT,
    "tableNumber" TEXT,
    "openedByUserId" TEXT,
    "checkNumber" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "diningMode" TEXT NOT NULL DEFAULT 'STAY',
    "chitDiscountPct" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "autoFireGapMinutes" INTEGER,
    "notes" TEXT,
    "settledAt" TIMESTAMP(3),
    "settledByUserId" TEXT,
    "closedAt" TIMESTAMP(3),
    "settlementMethod" TEXT,
    "receiptEmailStatus" TEXT,
    "receiptEmailAddress" TEXT,
    "receiptEmailedAt" TIMESTAMP(3),
    "receiptEmailFailure" TEXT,
    "posSaleId" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedByUserId" TEXT,
    "voidedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "reservationId" TEXT,
    "tableId" TEXT,
    "partySize" INTEGER,
    "serverId" TEXT,

    CONSTRAINT "POSCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POSCheckLine" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "checkId" TEXT NOT NULL,
    "menuItemId" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL DEFAULT 1,
    "unitPrice" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "discountPct" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "taxable" BOOLEAN NOT NULL DEFAULT true,
    "prepStation" TEXT NOT NULL DEFAULT 'KITCHEN',
    "course" INTEGER NOT NULL DEFAULT 1,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "hasAllergy" BOOLEAN NOT NULL DEFAULT false,
    "sentAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),
    "servedAt" TIMESTAMP(3),
    "servedByUserId" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedByUserId" TEXT,
    "voidedReason" TEXT,
    "compedByUserId" TEXT,
    "seatNumber" INTEGER,
    "tableLevel" BOOLEAN NOT NULL DEFAULT false,
    "settlementGroupId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "POSCheckLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POSChit" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "checkId" TEXT NOT NULL,
    "station" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "course" INTEGER NOT NULL DEFAULT 1,
    "sentByUserId" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firedAt" TIMESTAMP(3),
    "fireAt" TIMESTAMP(3),
    "printedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedByUserId" TEXT,
    "readyAt" TIMESTAMP(3),
    "readyByUserId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledByUserId" TEXT,
    "cancelledReason" TEXT,

    CONSTRAINT "POSChit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POSChitLine" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "chitId" TEXT NOT NULL,
    "checkLineId" TEXT NOT NULL,
    "displayDescription" TEXT NOT NULL,
    "displayQuantity" DECIMAL(65,30) NOT NULL DEFAULT 1,
    "displayNote" TEXT,
    "displaySeatNumber" INTEGER,
    "displayTableLevel" BOOLEAN NOT NULL DEFAULT false,
    "servedAt" TIMESTAMP(3),
    "servedByUserId" TEXT,

    CONSTRAINT "POSChitLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POSCheckEvent" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "checkId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payloadJson" TEXT,
    "byUserId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "POSCheckEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POSIntegrationProvider" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "configJson" TEXT,
    "secretsJson" TEXT,
    "webhookSecret" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "POSIntegrationProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LLMCommentaryDraft" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "subjectEntityType" TEXT,
    "subjectEntityId" TEXT,
    "promptTemplate" TEXT,
    "promptVariables" TEXT,
    "generatedText" TEXT,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "notes" TEXT,
    "requestedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LLMCommentaryDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackgroundJob" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "queue" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "idempotencyKey" TEXT,
    "scheduledFor" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "resultJson" TEXT,
    "correlationId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackgroundJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "jobId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "workerId" TEXT,

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobFailure" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "jobId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "errorMessage" TEXT NOT NULL,
    "stack" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobFailure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QueueHealth" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "queue" TEXT NOT NULL,
    "queueDepth" INTEGER NOT NULL DEFAULT 0,
    "inFlight" INTEGER NOT NULL DEFAULT 0,
    "failedLastHour" INTEGER NOT NULL DEFAULT 0,
    "deadLetterCount" INTEGER NOT NULL DEFAULT 0,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QueueHealth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POSWebhookEvent" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signature" TEXT,
    "signatureVerified" BOOLEAN NOT NULL DEFAULT false,
    "rawPayload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "failureReason" TEXT,
    "processedAt" TIMESTAMP(3),
    "resultingSaleId" TEXT,
    "jobId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "POSWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POSSyncRun" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "totalReceived" INTEGER NOT NULL DEFAULT 0,
    "totalCreated" INTEGER NOT NULL DEFAULT 0,
    "totalSkipped" INTEGER NOT NULL DEFAULT 0,
    "totalFailed" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "errorMessage" TEXT,

    CONSTRAINT "POSSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POSImportError" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "webhookEventId" TEXT,
    "providerKey" TEXT NOT NULL,
    "errorMessage" TEXT NOT NULL,
    "payloadSnippet" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "POSImportError_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POSMapping" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "spectreId" TEXT NOT NULL,
    "metaJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "POSMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookReplay" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "scope" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookReplay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Course" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "holes" INTEGER NOT NULL DEFAULT 18,
    "parTotal" INTEGER NOT NULL DEFAULT 72,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Course_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourseHole" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "holeNumber" INTEGER NOT NULL,
    "par" INTEGER NOT NULL DEFAULT 4,
    "yardage" INTEGER,
    "handicap" INTEGER,

    CONSTRAINT "CourseHole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeeSheet" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "sheetDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "bookingOpensAt" TIMESTAMP(3),
    "bookingClosesAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeeSheet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeeTime" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "teeSheetId" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "intervalMinutes" INTEGER NOT NULL DEFAULT 10,
    "maxPlayers" INTEGER NOT NULL DEFAULT 4,
    "startingTee" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeeTime_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeeTimeBooking" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "teeTimeId" TEXT NOT NULL,
    "primaryMemberId" TEXT NOT NULL,
    "guestCount" INTEGER NOT NULL DEFAULT 0,
    "cartRequested" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'CONFIRMED',
    "bookingChannel" TEXT NOT NULL DEFAULT 'MEMBER_PORTAL',
    "bookedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "noShowChargedAt" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "TeeTimeBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeeTimePlayer" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "teeTimeId" TEXT NOT NULL,
    "bookingId" TEXT,
    "memberId" TEXT,
    "guestId" TEXT,
    "playerOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "TeeTimePlayer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeeTimeGuest" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT,
    "guestFeeChargeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeeTimeGuest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeeLottery" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "teeSheetId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "opensAt" TIMESTAMP(3) NOT NULL,
    "closesAt" TIMESTAMP(3) NOT NULL,
    "drawAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "strategy" TEXT NOT NULL DEFAULT 'RANDOM',
    "drawnAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeeLottery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeeLotteryEntry" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "lotteryId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "priorityScore" INTEGER NOT NULL DEFAULT 0,
    "preferredWindow" TEXT,
    "groupSize" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "assignedTeeTimeId" TEXT,
    "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeeLotteryEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaceOfPlayRecord" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "teeTimeId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "expectedMinutes" INTEGER NOT NULL DEFAULT 240,
    "actualMinutes" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaceOfPlayRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CartAssignment" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "teeTimeId" TEXT,
    "resourceCode" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'CART',
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "CartAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HardwareDevice" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT,
    "vendor" TEXT,
    "model" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "metaJson" TEXT,
    "firmwareVersion" TEXT,
    "authTokenHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HardwareDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceEvent" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'EVENT',
    "eventType" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metaJson" TEXT,

    CONSTRAINT "DeviceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceStatus" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "online" BOOLEAN NOT NULL DEFAULT true,
    "lastHeartbeat" TIMESTAMP(3),
    "batteryPercent" INTEGER,
    "signalStrength" INTEGER,
    "metaJson" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceStatus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceAssignment" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "DeviceAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeatureFlag" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "rolloutPercent" INTEGER NOT NULL DEFAULT 0,
    "scope" TEXT NOT NULL DEFAULT 'MODULE',
    "metaJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeatureFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimitBucket" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "scope" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "tokens" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "refillAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ObservabilityEvent" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'EVENT',
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OK',
    "correlationId" TEXT,
    "durationMs" INTEGER,
    "message" TEXT,
    "metaJson" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ObservabilityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetricCounter" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "name" TEXT NOT NULL,
    "labels" TEXT NOT NULL DEFAULT '{}',
    "value" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetricCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthAttempt" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "scope" TEXT NOT NULL,
    "emailHash" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "outcome" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountLock" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "userId" TEXT,
    "emailHash" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'AUTOMATIC',
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "releasedByUserId" TEXT,

    CONSTRAINT "AccountLock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuspiciousActivityEvent" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "kind" TEXT NOT NULL,
    "emailHash" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'WATCH',
    "metaJson" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuspiciousActivityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebPushSubscription" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "userId" TEXT,
    "memberId" TEXT,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "authSecret" TEXT NOT NULL,
    "userAgent" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebPushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tournament" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "format" TEXT NOT NULL DEFAULT 'STROKE',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "registrationOpensAt" TIMESTAMP(3),
    "registrationClosesAt" TIMESTAMP(3),
    "entryFee" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "guestFee" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "maxParticipants" INTEGER,
    "courseId" TEXT,
    "revenueAccountId" TEXT,
    "notes" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tournament_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TournamentDivision" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "minHandicap" INTEGER,
    "maxHandicap" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "TournamentDivision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TournamentRegistration" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "divisionId" TEXT,
    "memberId" TEXT,
    "guestFirstName" TEXT,
    "guestLastName" TEXT,
    "guestEmail" TEXT,
    "teamId" TEXT,
    "handicap" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'REGISTERED',
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "feeChargeId" TEXT,
    "notes" TEXT,

    CONSTRAINT "TournamentRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TournamentTeam" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TournamentTeam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TournamentRound" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "roundNumber" INTEGER NOT NULL,
    "scheduledDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "notes" TEXT,

    CONSTRAINT "TournamentRound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TournamentMatch" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "bracketSlot" INTEGER,
    "playerARegistrationId" TEXT,
    "playerBRegistrationId" TEXT,
    "winnerRegistrationId" TEXT,
    "scoreA" INTEGER,
    "scoreB" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "TournamentMatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TournamentScore" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "memberId" TEXT,
    "holeNumber" INTEGER NOT NULL,
    "strokes" INTEGER NOT NULL,
    "putts" INTEGER,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedByUserId" TEXT,

    CONSTRAINT "TournamentScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TournamentLeaderboard" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "totalStrokes" INTEGER NOT NULL DEFAULT 0,
    "totalPoints" INTEGER NOT NULL DEFAULT 0,
    "positionRank" INTEGER NOT NULL DEFAULT 0,
    "divisionRank" INTEGER,
    "divisionId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TournamentLeaderboard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TournamentPayoutPrize" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "divisionId" TEXT,
    "label" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "awardedToRegistrationId" TEXT,
    "awardedAt" TIMESTAMP(3),

    CONSTRAINT "TournamentPayoutPrize_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TournamentCommunication" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'EMAIL',
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "sentByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TournamentCommunication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "ipAllowlist" TEXT,
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "revokedByUserId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKeyPermission" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "apiKeyId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,

    CONSTRAINT "ApiKeyPermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiRequestLog" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "apiKeyId" TEXT,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "responseCode" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "ip" TEXT,
    "userAgent" TEXT,
    "errorMessage" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiRequestLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookSubscription" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "apiKeyId" TEXT,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastDeliveryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "responseCode" INTEGER,
    "lastError" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PilotReadinessItem" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'MANUAL',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "details" TEXT,
    "completedAt" TIMESTAMP(3),
    "completedByUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PilotReadinessItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushDeliveryAttempt" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "campaignId" TEXT,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "failureReason" TEXT,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushDeliveryAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushCampaign" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "url" TEXT,
    "audienceJson" TEXT,
    "scheduledFor" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "totalQueued" INTEGER NOT NULL DEFAULT 0,
    "totalSent" INTEGER NOT NULL DEFAULT 0,
    "totalFailed" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TournamentPairing" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "teeTimeId" TEXT,
    "groupNumber" INTEGER NOT NULL DEFAULT 1,
    "registrationsJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TournamentPairing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionPlan" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "description" TEXT,
    "monthlyPrice" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "annualPrice" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "featuresJson" TEXT NOT NULL DEFAULT '[]',
    "seatLimit" INTEGER,
    "storageGb" INTEGER,
    "apiCallsPerMonth" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubSubscription" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "planId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PILOT',
    "seatCount" INTEGER NOT NULL DEFAULT 0,
    "trialEndsAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "notesJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageMetric" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "periodLabel" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingCycle" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "periodLabel" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "totalDue" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "totalPaid" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "invoiceJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingCycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookSecretVersion" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'ACTIVE',
    "secret" TEXT NOT NULL,
    "activatedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookSecretVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookSecretRotation" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "versionId" TEXT,
    "action" TEXT NOT NULL,
    "byUserId" TEXT,
    "reason" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookSecretRotation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POSMappingHistory" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "beforeJson" TEXT,
    "afterJson" TEXT,
    "action" TEXT NOT NULL,
    "byUserId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "POSMappingHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TournamentScoreDraft" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "scoresJson" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "lastEditorUserId" TEXT,
    "lastEditorLabel" TEXT,
    "submittedAt" TIMESTAMP(3),
    "submittedByUserId" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "acceptedByUserId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TournamentScoreDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TournamentScoreConflict" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "clientVersion" INTEGER NOT NULL,
    "serverVersion" INTEGER NOT NULL,
    "clientScoresJson" TEXT NOT NULL,
    "serverScoresJson" TEXT NOT NULL,
    "resolution" TEXT NOT NULL DEFAULT 'PENDING',
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TournamentScoreConflict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TournamentScoreCorrection" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "holeNumber" INTEGER NOT NULL,
    "beforeStrokes" INTEGER,
    "afterStrokes" INTEGER,
    "reason" TEXT NOT NULL,
    "byUserId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TournamentScoreCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingCustomer" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'stripe',
    "externalId" TEXT NOT NULL,
    "email" TEXT,
    "defaultPaymentMethod" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingCustomer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingSubscription" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'stripe',
    "externalId" TEXT NOT NULL,
    "planId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "metaJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingInvoice" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'stripe',
    "externalId" TEXT NOT NULL,
    "number" TEXT,
    "amountDue" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "amountPaid" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "hostedUrl" TEXT,
    "pdfUrl" TEXT,
    "dueDate" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingPaymentAttempt" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'stripe',
    "externalId" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "failureMessage" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingPaymentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingWebhookEvent" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'stripe',
    "externalEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "signature" TEXT,
    "signatureVerified" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "failureReason" TEXT,
    "processedAt" TIMESTAMP(3),
    "rawPayload" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MfaFactor" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'TOTP',
    "label" TEXT,
    "secret" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "lastUsedAt" TIMESTAMP(3),
    "enrolledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MfaFactor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrustedDevice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "label" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrustedDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SsoProvider" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "issuer" TEXT,
    "clientId" TEXT,
    "clientSecret" TEXT,
    "acsUrl" TEXT,
    "entityId" TEXT,
    "certificate" TEXT,
    "emailDomain" TEXT,
    "defaultRoleKey" TEXT NOT NULL DEFAULT 'STAFF',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SsoProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SsoLoginAttempt" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "providerId" TEXT,
    "email" TEXT,
    "status" TEXT NOT NULL,
    "failureReason" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SsoLoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecretAccessLog" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "scope" TEXT NOT NULL,
    "secretReference" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorApp" TEXT,
    "provider" TEXT,
    "keyId" TEXT,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OK',
    "errorMessage" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecretAccessLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KeyRotationEvent" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "scope" TEXT NOT NULL,
    "secretReference" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'MANUAL',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "oldKeyId" TEXT,
    "newKeyId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "startedByUserId" TEXT,
    "errorMessage" TEXT,

    CONSTRAINT "KeyRotationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EncryptedSecretMetadata" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "scope" TEXT NOT NULL,
    "secretReference" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'AES-256-GCM',
    "encryptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMP(3),
    "lastDecryptedAt" TIMESTAMP(3),

    CONSTRAINT "EncryptedSecretMetadata_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceApp" (
    "id" TEXT NOT NULL,
    "publisherUserId" TEXT,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "iconUrl" TEXT,
    "homepageUrl" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'THIRD_PARTY',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "defaultScopesJson" TEXT NOT NULL DEFAULT '[]',
    "clientId" TEXT NOT NULL,
    "clientSecretHash" TEXT NOT NULL,
    "redirectUris" TEXT NOT NULL,
    "webhookUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketplaceApp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstalledApp" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "installedByUserId" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "scopesJson" TEXT NOT NULL DEFAULT '[]',
    "notes" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,

    CONSTRAINT "InstalledApp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppPermission" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "installedAppId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "AppPermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthGrant" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "installedAppId" TEXT,
    "accessTokenHash" TEXT NOT NULL,
    "refreshTokenHash" TEXT,
    "scopesJson" TEXT NOT NULL DEFAULT '[]',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "OAuthGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppWebhookSubscription" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "installedAppId" TEXT NOT NULL,
    "events" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppWebhookSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessReview" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "title" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,

    CONSTRAINT "AccessReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessReviewItem" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "subjectLabel" TEXT,
    "currentJson" TEXT,
    "decision" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" TEXT,
    "notes" TEXT,

    CONSTRAINT "AccessReviewItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceEvidence" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "documentId" TEXT,
    "storageKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'GENERATED',
    "generatedByUserId" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComplianceEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyAcknowledgement" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "policyKey" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "acknowledgedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "PolicyAcknowledgement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CircuitBreakerState" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "resourceKey" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'CLOSED',
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "lastFailureAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "resetAt" TIMESTAMP(3),
    "thresholdHint" INTEGER NOT NULL DEFAULT 5,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CircuitBreakerState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PilotOnboardingProject" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "targetGoLiveAt" TIMESTAMP(3),
    "ownerUserId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "goLiveApprovedAt" TIMESTAMP(3),
    "goLiveApprovedByUserId" TEXT,

    CONSTRAINT "PilotOnboardingProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PilotOnboardingStep" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "stepKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "ordering" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "dataJson" TEXT,
    "completedAt" TIMESTAMP(3),
    "completedByUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PilotOnboardingStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PilotOnboardingTask" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "stepKey" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "ownerUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "dueDate" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PilotOnboardingTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PilotOnboardingNote" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "byUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PilotOnboardingNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PilotOnboardingBlocker" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "openedByUserId" TEXT,
    "resolvedByUserId" TEXT,

    CONSTRAINT "PilotOnboardingBlocker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PilotGoLiveSignoff" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "signedAt" TIMESTAMP(3),
    "signedByUserId" TEXT,
    "notes" TEXT,

    CONSTRAINT "PilotGoLiveSignoff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'CSV',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "fileName" TEXT,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "validRows" INTEGER NOT NULL DEFAULT 0,
    "errorRows" INTEGER NOT NULL DEFAULT 0,
    "committedRows" INTEGER NOT NULL DEFAULT 0,
    "mappingJson" TEXT,
    "optionsJson" TEXT,
    "dryRunAt" TIMESTAMP(3),
    "committedAt" TIMESTAMP(3),
    "rolledBackAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "supersededByBatchId" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedByUserId" TEXT,
    "voidReason" TEXT,
    "createdByUserId" TEXT,
    "committedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportRow" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "rawJson" TEXT NOT NULL,
    "normalizedJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "createdEntityType" TEXT,
    "createdEntityId" TEXT,

    CONSTRAINT "ImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportError" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "columnName" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'ERROR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportError_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpeningBalanceSet" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "fiscalYearId" TEXT,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "totalDebits" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "totalCredits" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "balanceJson" TEXT NOT NULL DEFAULT '[]',
    "arSubledgerJson" TEXT,
    "apSubledgerJson" TEXT,
    "journalEntryId" TEXT,
    "postedAt" TIMESTAMP(3),
    "postedByUserId" TEXT,
    "lockedAt" TIMESTAMP(3),
    "lockedByUserId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpeningBalanceSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberPortalInvite" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "sentAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastError" TEXT,
    "sendCount" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberPortalInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubTrainingMode" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "enabledAt" TIMESTAMP(3),
    "enabledByUserId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "notes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubTrainingMode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingScenario" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "roleKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "completedAt" TIMESTAMP(3),
    "completedByUserId" TEXT,

    CONSTRAINT "TrainingScenario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportAccessGrant" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "supportUserId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "approvedByUserId" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'READ_ONLY',
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "SupportAccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportSession" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "grantId" TEXT,
    "supportUserId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'READ_ONLY',
    "ip" TEXT,
    "userAgent" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "SupportSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportActionLog" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "allowed" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportActionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Incident" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'SEV3',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mitigatedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "ownerUserId" TEXT,
    "resolutionNotes" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentTimelineEvent" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "incidentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "byUserId" TEXT,
    "refType" TEXT,
    "refId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncidentTimelineEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportTicket" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'NORMAL',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "openedByUserId" TEXT,
    "assignedToUserId" TEXT,
    "category" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNotes" TEXT,

    CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubDomain" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'PRIMARY',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "verificationToken" TEXT NOT NULL DEFAULT '',
    "verifiedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnownIssue" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'WARNING',
    "status" TEXT NOT NULL DEFAULT 'INVESTIGATING',
    "workaround" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "KnownIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportTemplate" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "scope" TEXT NOT NULL DEFAULT 'CLUB',
    "source" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "mappingJson" TEXT NOT NULL DEFAULT '{}',
    "requiredColumns" TEXT NOT NULL DEFAULT '[]',
    "transformsJson" TEXT NOT NULL DEFAULT '{}',
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailDeliveryEvent" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "email" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'unknown',
    "messageId" TEXT,
    "reason" TEXT,
    "rawPayload" TEXT,
    "inviteId" TEXT,
    "notificationDeliveryId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailDeliveryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailSuppression" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "email" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "addedByUserId" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PilotRetrospective" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "projectId" TEXT,
    "timing" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "conductedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "conductedByUserId" TEXT,
    "notes" TEXT,

    CONSTRAINT "PilotRetrospective_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RetrospectiveItem" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "retrospectiveId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "linkedIncidentId" TEXT,
    "linkedTicketId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RetrospectiveItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RetrospectiveAction" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "retrospectiveId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "ownerUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "dueDate" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "RetrospectiveAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PilotMetricSnapshot" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openTickets" INTEGER NOT NULL DEFAULT 0,
    "resolvedTickets" INTEGER NOT NULL DEFAULT 0,
    "openIncidents" INTEGER NOT NULL DEFAULT 0,
    "failedJobs" INTEGER NOT NULL DEFAULT 0,
    "inviteSent" INTEGER NOT NULL DEFAULT 0,
    "inviteActivated" INTEGER NOT NULL DEFAULT 0,
    "inviteActivationRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "importBatches" INTEGER NOT NULL DEFAULT 0,
    "importErrorRows" INTEGER NOT NULL DEFAULT 0,
    "memberLogins7d" INTEGER NOT NULL DEFAULT 0,
    "apApprovedLast7d" INTEGER NOT NULL DEFAULT 0,
    "arPostedLast7d" INTEGER NOT NULL DEFAULT 0,
    "smokePass" INTEGER NOT NULL DEFAULT 0,
    "smokeFail" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,

    CONSTRAINT "PilotMetricSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospitalitySurveyInvitation" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "memberId" TEXT,
    "posCheckId" TEXT,
    "posSaleId" TEXT,
    "posSettlementGroupId" TEXT,
    "departmentKey" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HospitalitySurveyInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospitalitySurveyResponse" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "invitationId" TEXT NOT NULL,
    "memberId" TEXT,
    "posCheckId" TEXT,
    "posSaleId" TEXT,
    "posSettlementGroupId" TEXT,
    "departmentKey" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "serviceRecoveryStatus" TEXT NOT NULL DEFAULT 'NONE',
    "urgent" BOOLEAN NOT NULL DEFAULT false,
    "assignedToUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewedByUserId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "internalNotes" TEXT,
    "notificationRouted" BOOLEAN NOT NULL DEFAULT false,
    "notificationFailure" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HospitalitySurveyResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepartmentNotificationRule" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "departmentKey" TEXT NOT NULL,
    "departmentName" TEXT NOT NULL,
    "notifyUserId" TEXT,
    "notifyEmail" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "thresholdRating" INTEGER NOT NULL DEFAULT 5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepartmentNotificationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiningArea" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "floorElementsJson" TEXT,
    "canvasWidth" INTEGER NOT NULL DEFAULT 1000,
    "canvasHeight" INTEGER NOT NULL DEFAULT 700,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiningArea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiningTable" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "diningAreaId" TEXT NOT NULL,
    "tableNumber" TEXT NOT NULL,
    "displayName" TEXT,
    "capacity" INTEGER NOT NULL DEFAULT 4,
    "minPartySize" INTEGER NOT NULL DEFAULT 1,
    "maxPartySize" INTEGER NOT NULL DEFAULT 8,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "xPos" DOUBLE PRECISION,
    "yPos" DOUBLE PRECISION,
    "width" INTEGER NOT NULL DEFAULT 80,
    "height" INTEGER NOT NULL DEFAULT 80,
    "rotation" INTEGER NOT NULL DEFAULT 0,
    "shape" TEXT NOT NULL DEFAULT 'ROUND',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiningTable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiningFloorPlan" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "diningAreaId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "versionNumber" INTEGER NOT NULL DEFAULT 1,
    "savedById" TEXT,
    "publishedById" TEXT,
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiningFloorPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiningFloorPlanTable" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "floorPlanId" TEXT NOT NULL,
    "sourceDiningTableId" TEXT,
    "tableNumber" TEXT NOT NULL,
    "displayName" TEXT,
    "shape" TEXT NOT NULL DEFAULT 'ROUND',
    "capacity" INTEGER NOT NULL DEFAULT 4,
    "xPos" DOUBLE PRECISION NOT NULL,
    "yPos" DOUBLE PRECISION NOT NULL,
    "width" INTEGER NOT NULL DEFAULT 80,
    "height" INTEGER NOT NULL DEFAULT 80,
    "rotation" INTEGER NOT NULL DEFAULT 0,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiningFloorPlanTable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiningReservation" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "memberId" TEXT,
    "guestName" TEXT,
    "guestEmail" TEXT,
    "guestPhone" TEXT,
    "reservationType" TEXT NOT NULL DEFAULT 'MEMBER',
    "status" TEXT NOT NULL DEFAULT 'CONFIRMED',
    "reservationDate" TIMESTAMP(3) NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "expectedEndTime" TIMESTAMP(3) NOT NULL,
    "actualSeatedAt" TIMESTAMP(3),
    "actualDepartedAt" TIMESTAMP(3),
    "partySize" INTEGER NOT NULL,
    "diningAreaId" TEXT NOT NULL,
    "tableId" TEXT,
    "specialRequests" TEXT,
    "occasion" TEXT,
    "dressCodeAcknowledged" BOOLEAN NOT NULL DEFAULT false,
    "noShowFeeAcknowledged" BOOLEAN NOT NULL DEFAULT false,
    "confirmationSentAt" TIMESTAMP(3),
    "confirmationEmailStatus" TEXT,
    "confirmationEmailAddress" TEXT,
    "confirmationEmailFailure" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledByUserId" TEXT,
    "cancellationReason" TEXT,
    "noShowMarkedAt" TIMESTAMP(3),
    "noShowMarkedByUserId" TEXT,
    "noShowReason" TEXT,
    "noShowFeeChargeId" TEXT,
    "noShowFeeChargedAt" TIMESTAMP(3),
    "hostNotes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiningReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiningReservationCheckLink" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "posCheckId" TEXT NOT NULL,
    "posSaleId" TEXT,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiningReservationCheckLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReservationSettings" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "reservationIntervalMinutes" INTEGER NOT NULL DEFAULT 15,
    "defaultReservationDurationMinutes" INTEGER NOT NULL DEFAULT 90,
    "noShowFeeAmount" DECIMAL(65,30) NOT NULL DEFAULT 25.00,
    "noShowFeeEnabled" BOOLEAN NOT NULL DEFAULT true,
    "confirmationEmailEnabled" BOOLEAN NOT NULL DEFAULT true,
    "autoConfirmMemberReservations" BOOLEAN NOT NULL DEFAULT true,
    "dressCodeText" TEXT NOT NULL DEFAULT 'Smart-casual attire is required in all Club dining areas. Denim, athletic apparel, and head coverings are not permitted. Collared shirts are required for gentlemen.',
    "noShowPolicyText" TEXT NOT NULL DEFAULT 'Please cancel at least two hours in advance. Missed reservations may be subject to a no-show fee charged to the member account.',
    "contactPhone" TEXT,
    "contactEmail" TEXT,
    "maxPartySizeOnline" INTEGER NOT NULL DEFAULT 8,
    "advanceBookingDays" INTEGER NOT NULL DEFAULT 60,
    "cancellationCutoffHours" INTEGER NOT NULL DEFAULT 2,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReservationSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POSSettlementGroup" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "posCheckId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "settlementMethod" TEXT,
    "memberId" TEXT,
    "posSaleId" TEXT,
    "subtotal" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "grandTotal" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    "receiptEmailStatus" TEXT,
    "receiptEmailAddress" TEXT,
    "receiptEmailedAt" TIMESTAMP(3),
    "receiptEmailFailure" TEXT,

    CONSTRAINT "POSSettlementGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POSCheckSeat" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "posCheckId" TEXT NOT NULL,
    "seatNumber" INTEGER NOT NULL,
    "memberId" TEXT,
    "guestName" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "POSCheckSeat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POSQRPayment" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "posCheckId" TEXT NOT NULL,
    "memberId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QR_ISSUED',
    "amount" DECIMAL(65,30) NOT NULL,
    "paymentUrl" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "posSaleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "POSQRPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportingLedgerBatch" (
    "batchId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "notes" TEXT,
    "sourceFile" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "ReportingLedgerBatch_pkey" PRIMARY KEY ("batchId")
);

-- CreateTable
CREATE TABLE "ReportingLedgerSnapshot" (
    "snapshotId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "entityKind" TEXT NOT NULL,
    "batchState" TEXT NOT NULL DEFAULT 'committed',
    "importBatchId" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceSystem" TEXT NOT NULL,
    "sourceFile" TEXT,
    "dataSource" TEXT NOT NULL,
    "notes" TEXT,
    "asOf" TIMESTAMP(3),
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "fiscalYearLabel" TEXT,
    "reportingPeriod" TEXT,
    "payloadHash" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,

    CONSTRAINT "ReportingLedgerSnapshot_pkey" PRIMARY KEY ("snapshotId")
);

-- CreateTable
CREATE TABLE "WorkIntakeItem" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "ownerUserId" TEXT,
    "judgmentRequired" BOOLEAN NOT NULL DEFAULT false,
    "deferredUntil" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "classification" TEXT,
    "classificationReason" TEXT,
    "classificationMethod" TEXT,
    "classificationConfidence" DOUBLE PRECISION,
    "classificationRuleKey" TEXT,
    "classificationRuleVersion" INTEGER,
    "classificationOverriddenByUserId" TEXT,
    "classificationOverriddenAt" TIMESTAMP(3),
    "displaySourceLabel" TEXT NOT NULL,
    "displaySender" TEXT NOT NULL,
    "displaySubject" TEXT NOT NULL,
    "displayPreview" TEXT NOT NULL,
    "displayReceivedAt" TIMESTAMP(3) NOT NULL,
    "displayHasAttachments" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkIntakeItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkIntakeActivity" (
    "id" TEXT NOT NULL,
    "workIntakeItemId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "fromValue" TEXT,
    "toValue" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkIntakeActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailWorkIntakeOrigin" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "workIntakeItemId" TEXT NOT NULL,
    "emailMessageId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'PRIMARY',
    "linkReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT,

    CONSTRAINT "EmailWorkIntakeOrigin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailboxConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "mailboxType" TEXT NOT NULL DEFAULT 'PERSONAL',
    "externalUserId" TEXT NOT NULL,
    "microsoftTenantId" TEXT NOT NULL,
    "connectedEmail" TEXT NOT NULL,
    "accessTokenSecretRef" TEXT,
    "refreshTokenSecretRef" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "grantedScopes" TEXT NOT NULL,
    "tokenRevision" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'CONNECTED',
    "lastSuccessfulSyncAt" TIMESTAMP(3),
    "lastAttemptedSyncAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "deltaLink" TEXT,
    "disconnectedAt" TIMESTAMP(3),
    "disconnectedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailboxConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailboxAccess" (
    "id" TEXT NOT NULL,
    "mailboxConnectionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "grantedByUserId" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailboxAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraphSubscription" (
    "id" TEXT NOT NULL,
    "mailboxConnectionId" TEXT NOT NULL,
    "microsoftSubscriptionId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "changeTypes" TEXT NOT NULL,
    "clientStateSecretRef" TEXT NOT NULL,
    "expirationDateTime" TIMESTAMP(3) NOT NULL,
    "lifecycleState" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastRenewalAt" TIMESTAMP(3),
    "lastNotificationAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GraphSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailMessage" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "mailboxConnectionId" TEXT NOT NULL,
    "graphMessageId" TEXT NOT NULL,
    "immutableId" TEXT,
    "internetMessageId" TEXT,
    "conversationId" TEXT,
    "senderName" TEXT NOT NULL,
    "senderAddress" TEXT NOT NULL,
    "recipientsJson" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "preview" TEXT NOT NULL,
    "bodyHtmlSanitized" TEXT,
    "bodyTextExtract" TEXT,
    "importance" TEXT NOT NULL DEFAULT 'normal',
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "hasAttachments" BOOLEAN NOT NULL DEFAULT false,
    "webLink" TEXT,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL,
    "softDeletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ingestFailedAt" TIMESTAMP(3),
    "ingestFailReason" TEXT,
    "retryAttempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "EmailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailboxSyncRun" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "mailboxConnectionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "triggerKind" TEXT NOT NULL,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "messagesExamined" INTEGER NOT NULL DEFAULT 0,
    "messagesImported" INTEGER NOT NULL DEFAULT 0,
    "messagesUpdated" INTEGER NOT NULL DEFAULT 0,
    "intakeCreatedActionable" INTEGER NOT NULL DEFAULT 0,
    "intakeCreatedInformational" INTEGER NOT NULL DEFAULT 0,
    "messagesSuppressed" INTEGER NOT NULL DEFAULT 0,
    "messagesFailed" INTEGER NOT NULL DEFAULT 0,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "failureCategory" TEXT,

    CONSTRAINT "MailboxSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailboxOAuthTransaction" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "pkceVerifier" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "returnPath" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "outcome" TEXT,

    CONSTRAINT "MailboxOAuthTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailAttachment" (
    "id" TEXT NOT NULL,
    "emailMessageId" TEXT NOT NULL,
    "graphAttachmentId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "isInline" BOOLEAN NOT NULL DEFAULT false,
    "storageState" TEXT NOT NULL DEFAULT 'METADATA_ONLY',
    "storageKey" TEXT,
    "scanState" TEXT NOT NULL DEFAULT 'NOT_SCANNED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Club_slug_key" ON "Club"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "ClubProfile_clubId_key" ON "ClubProfile"("clubId");

-- CreateIndex
CREATE INDEX "ClubProfile_clubId_idx" ON "ClubProfile"("clubId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_memberId_key" ON "User"("memberId");

-- CreateIndex
CREATE INDEX "RolePermission_roleKey_idx" ON "RolePermission"("roleKey");

-- CreateIndex
CREATE INDEX "RolePermission_permissionKey_idx" ON "RolePermission"("permissionKey");

-- CreateIndex
CREATE INDEX "UserClubRole_userId_idx" ON "UserClubRole"("userId");

-- CreateIndex
CREATE INDEX "UserClubRole_clubId_idx" ON "UserClubRole"("clubId");

-- CreateIndex
CREATE INDEX "UserClubRole_roleKey_idx" ON "UserClubRole"("roleKey");

-- CreateIndex
CREATE UNIQUE INDEX "UserClubRole_userId_clubId_roleKey_key" ON "UserClubRole"("userId", "clubId", "roleKey");

-- CreateIndex
CREATE INDEX "AuditLog_clubId_createdAt_idx" ON "AuditLog"("clubId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX "ApplicationHouseholdMember_applicantId_idx" ON "ApplicationHouseholdMember"("applicantId");

-- CreateIndex
CREATE INDEX "ApplicationDocument_applicantId_idx" ON "ApplicationDocument"("applicantId");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationDraftToken_tokenHash_key" ON "ApplicationDraftToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ApplicationDraftToken_applicantId_idx" ON "ApplicationDraftToken"("applicantId");

-- CreateIndex
CREATE INDEX "ApplicationDraftToken_email_idx" ON "ApplicationDraftToken"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Member_applicantId_key" ON "Member"("applicantId");

-- CreateIndex
CREATE INDEX "Member_clubId_status_idx" ON "Member"("clubId", "status");

-- CreateIndex
CREATE INDEX "Member_clubId_lastName_idx" ON "Member"("clubId", "lastName");

-- CreateIndex
CREATE INDEX "Member_clubId_email_idx" ON "Member"("clubId", "email");

-- CreateIndex
CREATE INDEX "Member_clubId_membershipCategory_idx" ON "Member"("clubId", "membershipCategory");

-- CreateIndex
CREATE UNIQUE INDEX "Member_clubId_memberNumber_key" ON "Member"("clubId", "memberNumber");

-- CreateIndex
CREATE UNIQUE INDEX "MemberAccount_memberId_key" ON "MemberAccount"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "Charge_reversesId_key" ON "Charge"("reversesId");

-- CreateIndex
CREATE INDEX "Charge_memberId_transactionDate_idx" ON "Charge"("memberId", "transactionDate");

-- CreateIndex
CREATE INDEX "Charge_clubId_status_idx" ON "Charge"("clubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_retryOfId_key" ON "Payment"("retryOfId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_reversesId_key" ON "Payment"("reversesId");

-- CreateIndex
CREATE INDEX "Payment_memberId_paymentDate_idx" ON "Payment"("memberId", "paymentDate");

-- CreateIndex
CREATE INDEX "Payment_clubId_status_idx" ON "Payment"("clubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "FinancingAgreement_currentDocumentId_key" ON "FinancingAgreement"("currentDocumentId");

-- CreateIndex
CREATE INDEX "FinancingDocument_clubId_agreementId_idx" ON "FinancingDocument"("clubId", "agreementId");

-- CreateIndex
CREATE UNIQUE INDEX "FinancingDocument_agreementId_version_key" ON "FinancingDocument"("agreementId", "version");

-- CreateIndex
CREATE INDEX "FinancingPayment_agreementId_idx" ON "FinancingPayment"("agreementId");

-- CreateIndex
CREATE INDEX "FinancingPaymentSchedule_financingAgreementId_paymentNumber_idx" ON "FinancingPaymentSchedule"("financingAgreementId", "paymentNumber");

-- CreateIndex
CREATE INDEX "CollectionNotice_memberId_createdAt_idx" ON "CollectionNotice"("memberId", "createdAt");

-- CreateIndex
CREATE INDEX "CollectionNotice_clubId_status_idx" ON "CollectionNotice"("clubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionNoticeTemplate_clubId_key_key" ON "CollectionNoticeTemplate"("clubId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionStage_clubId_key_key" ON "CollectionStage"("clubId", "key");

-- CreateIndex
CREATE INDEX "CollectionAction_memberId_createdAt_idx" ON "CollectionAction"("memberId", "createdAt");

-- CreateIndex
CREATE INDEX "CollectionAction_clubId_createdAt_idx" ON "CollectionAction"("clubId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MemberPreference_memberId_key" ON "MemberPreference"("memberId");

-- CreateIndex
CREATE INDEX "OnboardingChecklistItem_memberId_idx" ON "OnboardingChecklistItem"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "OnboardingChecklistItem_memberId_itemKey_key" ON "OnboardingChecklistItem"("memberId", "itemKey");

-- CreateIndex
CREATE UNIQUE INDEX "ClubWidgetConfig_clubId_widgetType_key" ON "ClubWidgetConfig"("clubId", "widgetType");

-- CreateIndex
CREATE INDEX "MemberHouseholdMember_memberId_idx" ON "MemberHouseholdMember"("memberId");

-- CreateIndex
CREATE INDEX "MemberDocument_memberId_kind_idx" ON "MemberDocument"("memberId", "kind");

-- CreateIndex
CREATE INDEX "ClubAnnouncement_clubId_publishedAt_idx" ON "ClubAnnouncement"("clubId", "publishedAt");

-- CreateIndex
CREATE INDEX "AccountAdjustment_memberId_transactionDate_idx" ON "AccountAdjustment"("memberId", "transactionDate");

-- CreateIndex
CREATE INDEX "AccountAdjustment_clubId_status_idx" ON "AccountAdjustment"("clubId", "status");

-- CreateIndex
CREATE INDEX "AccountNote_memberId_createdAt_idx" ON "AccountNote"("memberId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentPromise_memberId_status_idx" ON "PaymentPromise"("memberId", "status");

-- CreateIndex
CREATE INDEX "Dispute_memberId_status_idx" ON "Dispute"("memberId", "status");

-- CreateIndex
CREATE INDEX "Statement_clubId_issuedAt_idx" ON "Statement"("clubId", "issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Statement_memberId_periodStart_periodEnd_key" ON "Statement"("memberId", "periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "Department_clubId_isActive_idx" ON "Department"("clubId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Department_clubId_code_key" ON "Department"("clubId", "code");

-- CreateIndex
CREATE INDEX "CostCenter_clubId_isActive_idx" ON "CostCenter"("clubId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "CostCenter_clubId_code_key" ON "CostCenter"("clubId", "code");

-- CreateIndex
CREATE INDEX "FinancialStatementGroup_clubId_statement_idx" ON "FinancialStatementGroup"("clubId", "statement");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialStatementGroup_clubId_key_key" ON "FinancialStatementGroup"("clubId", "key");

-- CreateIndex
CREATE INDEX "AccountCategory_clubId_type_idx" ON "AccountCategory"("clubId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "AccountCategory_clubId_key_key" ON "AccountCategory"("clubId", "key");

-- CreateIndex
CREATE INDEX "Account_clubId_isActive_idx" ON "Account"("clubId", "isActive");

-- CreateIndex
CREATE INDEX "Account_clubId_type_idx" ON "Account"("clubId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "Account_clubId_accountNumber_key" ON "Account"("clubId", "accountNumber");

-- CreateIndex
CREATE INDEX "AccountDepartment_clubId_idx" ON "AccountDepartment"("clubId");

-- CreateIndex
CREATE INDEX "AccountDepartment_departmentId_idx" ON "AccountDepartment"("departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountDepartment_accountId_departmentId_key" ON "AccountDepartment"("accountId", "departmentId");

-- CreateIndex
CREATE INDEX "FiscalYear_clubId_status_idx" ON "FiscalYear"("clubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "FiscalYear_clubId_label_key" ON "FiscalYear"("clubId", "label");

-- CreateIndex
CREATE INDEX "FiscalPeriod_clubId_startDate_endDate_idx" ON "FiscalPeriod"("clubId", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "FiscalPeriod_clubId_status_idx" ON "FiscalPeriod"("clubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "FiscalPeriod_clubId_label_key" ON "FiscalPeriod"("clubId", "label");

-- CreateIndex
CREATE INDEX "JournalBatch_clubId_status_idx" ON "JournalBatch"("clubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "JournalBatch_clubId_batchNumber_key" ON "JournalBatch"("clubId", "batchNumber");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_reversesId_key" ON "JournalEntry"("reversesId");

-- CreateIndex
CREATE INDEX "JournalEntry_clubId_status_idx" ON "JournalEntry"("clubId", "status");

-- CreateIndex
CREATE INDEX "JournalEntry_clubId_entryDate_idx" ON "JournalEntry"("clubId", "entryDate");

-- CreateIndex
CREATE INDEX "JournalEntry_periodId_idx" ON "JournalEntry"("periodId");

-- CreateIndex
CREATE INDEX "JournalEntry_sourceEntityType_sourceEntityId_idx" ON "JournalEntry"("sourceEntityType", "sourceEntityId");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_clubId_entryNumber_key" ON "JournalEntry"("clubId", "entryNumber");

-- CreateIndex
CREATE INDEX "JournalEntryLine_accountId_idx" ON "JournalEntryLine"("accountId");

-- CreateIndex
CREATE INDEX "JournalEntryLine_journalEntryId_idx" ON "JournalEntryLine"("journalEntryId");

-- CreateIndex
CREATE INDEX "JournalEntryLine_memberId_idx" ON "JournalEntryLine"("memberId");

-- CreateIndex
CREATE INDEX "RecurringJournal_clubId_isActive_nextRunDate_idx" ON "RecurringJournal"("clubId", "isActive", "nextRunDate");

-- CreateIndex
CREATE INDEX "JournalAttachment_journalEntryId_idx" ON "JournalAttachment"("journalEntryId");

-- CreateIndex
CREATE INDEX "Vendor_clubId_status_idx" ON "Vendor"("clubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Vendor_clubId_vendorNumber_key" ON "Vendor"("clubId", "vendorNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Vendor_clubId_legalName_key" ON "Vendor"("clubId", "legalName");

-- CreateIndex
CREATE INDEX "VendorContact_vendorId_idx" ON "VendorContact"("vendorId");

-- CreateIndex
CREATE INDEX "VendorBankingProfile_vendorId_idx" ON "VendorBankingProfile"("vendorId");

-- CreateIndex
CREATE INDEX "VendorBankingProfile_clubId_status_idx" ON "VendorBankingProfile"("clubId", "status");

-- CreateIndex
CREATE INDEX "PennyTest_vendorId_idx" ON "PennyTest"("vendorId");

-- CreateIndex
CREATE INDEX "PennyTest_clubId_status_idx" ON "PennyTest"("clubId", "status");

-- CreateIndex
CREATE INDEX "VendorDocument_vendorId_idx" ON "VendorDocument"("vendorId");

-- CreateIndex
CREATE INDEX "VendorRiskFlag_vendorId_resolvedAt_idx" ON "VendorRiskFlag"("vendorId", "resolvedAt");

-- CreateIndex
CREATE INDEX "TaxCode_clubId_isActive_idx" ON "TaxCode"("clubId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "TaxCode_clubId_key_key" ON "TaxCode"("clubId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalPolicy_clubId_entityType_key" ON "ApprovalPolicy"("clubId", "entityType");

-- CreateIndex
CREATE INDEX "ApprovalRequest_clubId_status_idx" ON "ApprovalRequest"("clubId", "status");

-- CreateIndex
CREATE INDEX "ApprovalRequest_entityType_entityId_idx" ON "ApprovalRequest"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "ApprovalDecision_clubId_idx" ON "ApprovalDecision"("clubId");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalDecision_requestId_userId_key" ON "ApprovalDecision"("requestId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "APInvoice_captureId_key" ON "APInvoice"("captureId");

-- CreateIndex
CREATE INDEX "APInvoice_clubId_status_idx" ON "APInvoice"("clubId", "status");

-- CreateIndex
CREATE INDEX "APInvoice_clubId_dueDate_idx" ON "APInvoice"("clubId", "dueDate");

-- CreateIndex
CREATE INDEX "APInvoice_vendorId_idx" ON "APInvoice"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "APInvoice_clubId_invoiceNumber_key" ON "APInvoice"("clubId", "invoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "APInvoice_clubId_vendorId_vendorReference_key" ON "APInvoice"("clubId", "vendorId", "vendorReference");

-- CreateIndex
CREATE INDEX "APInvoiceLine_invoiceId_idx" ON "APInvoiceLine"("invoiceId");

-- CreateIndex
CREATE INDEX "APInvoiceAttachment_invoiceId_idx" ON "APInvoiceAttachment"("invoiceId");

-- CreateIndex
CREATE INDEX "ReceiptCapture_clubId_status_idx" ON "ReceiptCapture"("clubId", "status");

-- CreateIndex
CREATE INDEX "PaymentBatch_clubId_status_idx" ON "PaymentBatch"("clubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentBatch_clubId_batchNumber_key" ON "PaymentBatch"("clubId", "batchNumber");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentBatchItem_paymentId_key" ON "PaymentBatchItem"("paymentId");

-- CreateIndex
CREATE INDEX "PaymentBatchItem_batchId_idx" ON "PaymentBatchItem"("batchId");

-- CreateIndex
CREATE INDEX "VendorPayment_clubId_status_idx" ON "VendorPayment"("clubId", "status");

-- CreateIndex
CREATE INDEX "VendorPayment_vendorId_idx" ON "VendorPayment"("vendorId");

-- CreateIndex
CREATE INDEX "VendorPayment_invoiceId_idx" ON "VendorPayment"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "VendorPayment_clubId_paymentNumber_key" ON "VendorPayment"("clubId", "paymentNumber");

-- CreateIndex
CREATE INDEX "APException_clubId_status_idx" ON "APException"("clubId", "status");

-- CreateIndex
CREATE INDEX "APException_invoiceId_idx" ON "APException"("invoiceId");

-- CreateIndex
CREATE INDEX "APException_vendorId_idx" ON "APException"("vendorId");

-- CreateIndex
CREATE INDEX "InventoryCategory_clubId_isActive_idx" ON "InventoryCategory"("clubId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryCategory_clubId_key_key" ON "InventoryCategory"("clubId", "key");

-- CreateIndex
CREATE INDEX "InventoryLocation_clubId_isActive_idx" ON "InventoryLocation"("clubId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryLocation_clubId_code_key" ON "InventoryLocation"("clubId", "code");

-- CreateIndex
CREATE INDEX "InventoryItem_clubId_isActive_idx" ON "InventoryItem"("clubId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryItem_clubId_sku_key" ON "InventoryItem"("clubId", "sku");

-- CreateIndex
CREATE INDEX "InventoryTransaction_clubId_itemId_transactionDate_idx" ON "InventoryTransaction"("clubId", "itemId", "transactionDate");

-- CreateIndex
CREATE INDEX "InventoryTransaction_sourceType_sourceId_idx" ON "InventoryTransaction"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "InventoryAdjustment_clubId_status_idx" ON "InventoryAdjustment"("clubId", "status");

-- CreateIndex
CREATE INDEX "InventoryAdjustment_itemId_idx" ON "InventoryAdjustment"("itemId");

-- CreateIndex
CREATE INDEX "InventoryCount_clubId_status_idx" ON "InventoryCount"("clubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryCount_clubId_countNumber_key" ON "InventoryCount"("clubId", "countNumber");

-- CreateIndex
CREATE INDEX "InventoryCountLine_countId_idx" ON "InventoryCountLine"("countId");

-- CreateIndex
CREATE INDEX "InventoryReceiving_clubId_status_idx" ON "InventoryReceiving"("clubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryReceiving_clubId_receivingNumber_key" ON "InventoryReceiving"("clubId", "receivingNumber");

-- CreateIndex
CREATE INDEX "InventoryReceivingLine_receivingId_idx" ON "InventoryReceivingLine"("receivingId");

-- CreateIndex
CREATE INDEX "InventoryTransfer_clubId_status_idx" ON "InventoryTransfer"("clubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryTransfer_clubId_transferNumber_key" ON "InventoryTransfer"("clubId", "transferNumber");

-- CreateIndex
CREATE INDEX "InventoryTransferLine_transferId_idx" ON "InventoryTransferLine"("transferId");

-- CreateIndex
CREATE UNIQUE INDEX "EventCategory_clubId_key_key" ON "EventCategory"("clubId", "key");

-- CreateIndex
CREATE INDEX "PrivateEventInquiry_clubId_status_idx" ON "PrivateEventInquiry"("clubId", "status");

-- CreateIndex
CREATE INDEX "PrivateEventBooking_clubId_status_idx" ON "PrivateEventBooking"("clubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PrivateEventBooking_clubId_bookingNumber_key" ON "PrivateEventBooking"("clubId", "bookingNumber");

-- CreateIndex
CREATE INDEX "PrivateEventDeposit_clubId_status_idx" ON "PrivateEventDeposit"("clubId", "status");

-- CreateIndex
CREATE INDEX "PrivateEventDeposit_bookingId_idx" ON "PrivateEventDeposit"("bookingId");

-- CreateIndex
CREATE INDEX "PrivateEventMenuSelection_bookingId_idx" ON "PrivateEventMenuSelection"("bookingId");

-- CreateIndex
CREATE INDEX "PrivateEventBarSelection_bookingId_idx" ON "PrivateEventBarSelection"("bookingId");

-- CreateIndex
CREATE INDEX "PrivateEventAddOn_bookingId_idx" ON "PrivateEventAddOn"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "GolfProfessional_userId_key" ON "GolfProfessional"("userId");

-- CreateIndex
CREATE INDEX "GolfProfessional_clubId_isActive_idx" ON "GolfProfessional"("clubId", "isActive");

-- CreateIndex
CREATE INDEX "LessonType_clubId_isActive_idx" ON "LessonType"("clubId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "LessonType_clubId_key_key" ON "LessonType"("clubId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "LessonBooking_memberChargeId_key" ON "LessonBooking"("memberChargeId");

-- CreateIndex
CREATE INDEX "LessonBooking_clubId_status_idx" ON "LessonBooking"("clubId", "status");

-- CreateIndex
CREATE INDEX "LessonBooking_instructorId_idx" ON "LessonBooking"("instructorId");

-- CreateIndex
CREATE INDEX "LessonBooking_memberId_idx" ON "LessonBooking"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "LessonBooking_clubId_bookingNumber_key" ON "LessonBooking"("clubId", "bookingNumber");

-- CreateIndex
CREATE INDEX "LessonPayable_clubId_status_idx" ON "LessonPayable"("clubId", "status");

-- CreateIndex
CREATE INDEX "LessonPayable_instructorId_idx" ON "LessonPayable"("instructorId");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeePosition_clubId_code_key" ON "EmployeePosition"("clubId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_userId_key" ON "Employee"("userId");

-- CreateIndex
CREATE INDEX "Employee_clubId_status_idx" ON "Employee"("clubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_clubId_employeeNumber_key" ON "Employee"("clubId", "employeeNumber");

-- CreateIndex
CREATE INDEX "PayrollPeriod_clubId_status_idx" ON "PayrollPeriod"("clubId", "status");

-- CreateIndex
CREATE INDEX "PayrollPeriod_clubId_startDate_endDate_idx" ON "PayrollPeriod"("clubId", "startDate", "endDate");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollPeriod_clubId_label_key" ON "PayrollPeriod"("clubId", "label");

-- CreateIndex
CREATE INDEX "Timesheet_clubId_status_idx" ON "Timesheet"("clubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Timesheet_clubId_employeeId_periodId_key" ON "Timesheet"("clubId", "employeeId", "periodId");

-- CreateIndex
CREATE INDEX "TimesheetEntry_timesheetId_idx" ON "TimesheetEntry"("timesheetId");

-- CreateIndex
CREATE INDEX "TimeClockEvent_clubId_employeeId_occurredAt_idx" ON "TimeClockEvent"("clubId", "employeeId", "occurredAt");

-- CreateIndex
CREATE INDEX "PayrollRun_clubId_status_idx" ON "PayrollRun"("clubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRun_clubId_runNumber_key" ON "PayrollRun"("clubId", "runNumber");

-- CreateIndex
CREATE INDEX "PayrollLine_runId_idx" ON "PayrollLine"("runId");

-- CreateIndex
CREATE INDEX "PayrollLine_employeeId_idx" ON "PayrollLine"("employeeId");

-- CreateIndex
CREATE INDEX "PayrollRemittance_clubId_status_idx" ON "PayrollRemittance"("clubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "LabourBudget_clubId_departmentId_periodLabel_key" ON "LabourBudget"("clubId", "departmentId", "periodLabel");

-- CreateIndex
CREATE UNIQUE INDEX "AssetCategory_clubId_key_key" ON "AssetCategory"("clubId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "AssetLocation_clubId_code_key" ON "AssetLocation"("clubId", "code");

-- CreateIndex
CREATE INDEX "CapitalAsset_clubId_status_idx" ON "CapitalAsset"("clubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CapitalAsset_clubId_assetNumber_key" ON "CapitalAsset"("clubId", "assetNumber");

-- CreateIndex
CREATE INDEX "AssetDepreciationEntry_clubId_periodLabel_idx" ON "AssetDepreciationEntry"("clubId", "periodLabel");

-- CreateIndex
CREATE UNIQUE INDEX "AssetDepreciationEntry_assetId_periodLabel_key" ON "AssetDepreciationEntry"("assetId", "periodLabel");

-- CreateIndex
CREATE INDEX "AssetMaintenanceRecord_assetId_idx" ON "AssetMaintenanceRecord"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "AssetDisposal_assetId_key" ON "AssetDisposal"("assetId");

-- CreateIndex
CREATE INDEX "AssetDisposal_clubId_idx" ON "AssetDisposal"("clubId");

-- CreateIndex
CREATE INDEX "Budget_clubId_status_idx" ON "Budget"("clubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Budget_clubId_fiscalYearId_name_version_key" ON "Budget"("clubId", "fiscalYearId", "name", "version");

-- CreateIndex
CREATE INDEX "BudgetLine_clubId_accountId_idx" ON "BudgetLine"("clubId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetLine_budgetId_accountId_departmentId_key" ON "BudgetLine"("budgetId", "accountId", "departmentId");

-- CreateIndex
CREATE INDEX "BudgetAssumption_budgetId_idx" ON "BudgetAssumption"("budgetId");

-- CreateIndex
CREATE INDEX "Forecast_clubId_status_idx" ON "Forecast"("clubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Forecast_clubId_fiscalYearId_name_key" ON "Forecast"("clubId", "fiscalYearId", "name");

-- CreateIndex
CREATE INDEX "ForecastLine_clubId_accountId_idx" ON "ForecastLine"("clubId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "ForecastLine_forecastId_accountId_departmentId_key" ON "ForecastLine"("forecastId", "accountId", "departmentId");

-- CreateIndex
CREATE INDEX "ReportDefinition_clubId_category_idx" ON "ReportDefinition"("clubId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "ReportDefinition_clubId_key_key" ON "ReportDefinition"("clubId", "key");

-- CreateIndex
CREATE INDEX "SavedReport_clubId_definitionId_idx" ON "SavedReport"("clubId", "definitionId");

-- CreateIndex
CREATE INDEX "ReportRun_clubId_definitionId_startedAt_idx" ON "ReportRun"("clubId", "definitionId", "startedAt");

-- CreateIndex
CREATE INDEX "ReportExport_clubId_reportRunId_idx" ON "ReportExport"("clubId", "reportRunId");

-- CreateIndex
CREATE INDEX "ReportExport_clubId_status_idx" ON "ReportExport"("clubId", "status");

-- CreateIndex
CREATE INDEX "ReportingPackage_clubId_status_idx" ON "ReportingPackage"("clubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ReportingPackage_clubId_name_version_key" ON "ReportingPackage"("clubId", "name", "version");

-- CreateIndex
CREATE INDEX "ReportingPackageSection_packageId_sortOrder_idx" ON "ReportingPackageSection"("packageId", "sortOrder");

-- CreateIndex
CREATE INDEX "ReportingPackageCommentary_clubId_packageId_idx" ON "ReportingPackageCommentary"("clubId", "packageId");

-- CreateIndex
CREATE INDEX "PackageDistribution_clubId_packageId_status_idx" ON "PackageDistribution"("clubId", "packageId", "status");

-- CreateIndex
CREATE INDEX "PackageApproval_clubId_packageId_idx" ON "PackageApproval"("clubId", "packageId");

-- CreateIndex
CREATE INDEX "MonthlyPackage_clubId_idx" ON "MonthlyPackage"("clubId");

-- CreateIndex
CREATE INDEX "MonthlyPackage_clubId_status_idx" ON "MonthlyPackage"("clubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MonthlyPackage_clubId_reportingYear_reportingMonth_key" ON "MonthlyPackage"("clubId", "reportingYear", "reportingMonth");

-- CreateIndex
CREATE INDEX "MonthlyPackageRecipient_monthlyPackageId_idx" ON "MonthlyPackageRecipient"("monthlyPackageId");

-- CreateIndex
CREATE INDEX "MonthlyPackageRecipient_recipientUserId_idx" ON "MonthlyPackageRecipient"("recipientUserId");

-- CreateIndex
CREATE INDEX "MonthlyPackageRecipient_recipientEmail_idx" ON "MonthlyPackageRecipient"("recipientEmail");

-- CreateIndex
CREATE INDEX "BoardRole_clubId_idx" ON "BoardRole"("clubId");

-- CreateIndex
CREATE INDEX "BoardRole_clubId_memberId_idx" ON "BoardRole"("clubId", "memberId");

-- CreateIndex
CREATE INDEX "BoardRole_clubId_termStartDate_termEndDate_idx" ON "BoardRole"("clubId", "termStartDate", "termEndDate");

-- CreateIndex
CREATE UNIQUE INDEX "AuditorAccessGrant_inviteToken_key" ON "AuditorAccessGrant"("inviteToken");

-- CreateIndex
CREATE INDEX "AuditorAccessGrant_clubId_status_idx" ON "AuditorAccessGrant"("clubId", "status");

-- CreateIndex
CREATE INDEX "AuditorAccessGrant_expiresAt_idx" ON "AuditorAccessGrant"("expiresAt");

-- CreateIndex
CREATE INDEX "AuditorSession_clubId_grantId_startedAt_idx" ON "AuditorSession"("clubId", "grantId", "startedAt");

-- CreateIndex
CREATE INDEX "AuditRequest_clubId_status_idx" ON "AuditRequest"("clubId", "status");

-- CreateIndex
CREATE INDEX "AuditRequestItem_requestId_idx" ON "AuditRequestItem"("requestId");

-- CreateIndex
CREATE INDEX "AuditExport_clubId_grantId_idx" ON "AuditExport"("clubId", "grantId");

-- CreateIndex
CREATE INDEX "Notification_clubId_toUserId_status_idx" ON "Notification"("clubId", "toUserId", "status");

-- CreateIndex
CREATE INDEX "Notification_clubId_toMemberId_status_idx" ON "Notification"("clubId", "toMemberId", "status");

-- CreateIndex
CREATE INDEX "Notification_clubId_status_createdAt_idx" ON "Notification"("clubId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationTemplate_clubId_key_key" ON "NotificationTemplate"("clubId", "key");

-- CreateIndex
CREATE INDEX "NotificationPreference_clubId_topic_idx" ON "NotificationPreference"("clubId", "topic");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_clubId_userId_memberId_topic_key" ON "NotificationPreference"("clubId", "userId", "memberId", "topic");

-- CreateIndex
CREATE INDEX "NotificationDelivery_notificationId_status_idx" ON "NotificationDelivery"("notificationId", "status");

-- CreateIndex
CREATE INDEX "CommunicationLog_clubId_occurredAt_idx" ON "CommunicationLog"("clubId", "occurredAt");

-- CreateIndex
CREATE INDEX "CommunicationLog_clubId_toMemberId_idx" ON "CommunicationLog"("clubId", "toMemberId");

-- CreateIndex
CREATE INDEX "CommunicationCampaign_clubId_status_idx" ON "CommunicationCampaign"("clubId", "status");

-- CreateIndex
CREATE INDEX "Document_clubId_folderId_idx" ON "Document"("clubId", "folderId");

-- CreateIndex
CREATE INDEX "Document_clubId_memberId_idx" ON "Document"("clubId", "memberId");

-- CreateIndex
CREATE INDEX "Document_clubId_vendorId_idx" ON "Document"("clubId", "vendorId");

-- CreateIndex
CREATE INDEX "Document_clubId_status_idx" ON "Document"("clubId", "status");

-- CreateIndex
CREATE INDEX "DocumentFolder_clubId_parentId_idx" ON "DocumentFolder"("clubId", "parentId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentFolder_clubId_path_key" ON "DocumentFolder"("clubId", "path");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentTag_clubId_key_key" ON "DocumentTag"("clubId", "key");

-- CreateIndex
CREATE INDEX "DocumentTagJoin_tagId_idx" ON "DocumentTagJoin"("tagId");

-- CreateIndex
CREATE INDEX "DocumentVersion_documentId_idx" ON "DocumentVersion"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentVersion_documentId_versionNumber_key" ON "DocumentVersion"("documentId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentAccess_signedUrlToken_key" ON "DocumentAccess"("signedUrlToken");

-- CreateIndex
CREATE INDEX "DocumentAccess_documentId_idx" ON "DocumentAccess"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentRetentionPolicy_clubId_key_key" ON "DocumentRetentionPolicy"("clubId", "key");

-- CreateIndex
CREATE INDEX "DocumentAuditLog_documentId_occurredAt_idx" ON "DocumentAuditLog"("documentId", "occurredAt");

-- CreateIndex
CREATE INDEX "DocumentAuditLog_clubId_occurredAt_idx" ON "DocumentAuditLog"("clubId", "occurredAt");

-- CreateIndex
CREATE INDEX "KPI_clubId_kind_idx" ON "KPI"("clubId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "KPI_clubId_key_key" ON "KPI"("clubId", "key");

-- CreateIndex
CREATE INDEX "KPIValue_clubId_kpiId_asOfDate_idx" ON "KPIValue"("clubId", "kpiId", "asOfDate");

-- CreateIndex
CREATE UNIQUE INDEX "KPIValue_kpiId_periodLabel_key" ON "KPIValue"("kpiId", "periodLabel");

-- CreateIndex
CREATE UNIQUE INDEX "KPIDashboard_clubId_key_key" ON "KPIDashboard"("clubId", "key");

-- CreateIndex
CREATE INDEX "KPIWidget_dashboardId_sortOrder_idx" ON "KPIWidget"("dashboardId", "sortOrder");

-- CreateIndex
CREATE INDEX "KPIThreshold_kpiId_idx" ON "KPIThreshold"("kpiId");

-- CreateIndex
CREATE INDEX "KPIAlert_clubId_kpiId_status_idx" ON "KPIAlert"("clubId", "kpiId", "status");

-- CreateIndex
CREATE INDEX "Workflow_clubId_entityType_entityId_idx" ON "Workflow"("clubId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "Workflow_clubId_status_idx" ON "Workflow"("clubId", "status");

-- CreateIndex
CREATE INDEX "WorkflowStep_workflowId_sortOrder_idx" ON "WorkflowStep"("workflowId", "sortOrder");

-- CreateIndex
CREATE INDEX "WorkflowAssignment_workflowId_status_idx" ON "WorkflowAssignment"("workflowId", "status");

-- CreateIndex
CREATE INDEX "WorkflowApproval_workflowId_stepId_idx" ON "WorkflowApproval"("workflowId", "stepId");

-- CreateIndex
CREATE INDEX "WorkflowComment_workflowId_createdAt_idx" ON "WorkflowComment"("workflowId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkflowHistory_workflowId_occurredAt_idx" ON "WorkflowHistory"("workflowId", "occurredAt");

-- CreateIndex
CREATE INDEX "ClubSetting_clubId_scope_idx" ON "ClubSetting"("clubId", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "ClubSetting_clubId_scope_key_key" ON "ClubSetting"("clubId", "scope", "key");

-- CreateIndex
CREATE INDEX "Insight_clubId_status_raisedAt_idx" ON "Insight"("clubId", "status", "raisedAt");

-- CreateIndex
CREATE INDEX "Insight_clubId_kind_severity_idx" ON "Insight"("clubId", "kind", "severity");

-- CreateIndex
CREATE INDEX "InsightRule_clubId_isActive_idx" ON "InsightRule"("clubId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "InsightRule_clubId_key_key" ON "InsightRule"("clubId", "key");

-- CreateIndex
CREATE INDEX "InsightAlert_clubId_ruleId_idx" ON "InsightAlert"("clubId", "ruleId");

-- CreateIndex
CREATE INDEX "SearchIndexEntry_clubId_entityType_idx" ON "SearchIndexEntry"("clubId", "entityType");

-- CreateIndex
CREATE INDEX "SearchIndexEntry_clubId_title_idx" ON "SearchIndexEntry"("clubId", "title");

-- CreateIndex
CREATE UNIQUE INDEX "SearchIndexEntry_clubId_entityType_entityId_key" ON "SearchIndexEntry"("clubId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "IntegrationSetting_clubId_scope_idx" ON "IntegrationSetting"("clubId", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationSetting_clubId_scope_provider_key" ON "IntegrationSetting"("clubId", "scope", "provider");

-- CreateIndex
CREATE INDEX "IntegrationCheck_clubId_scope_checkedAt_idx" ON "IntegrationCheck"("clubId", "scope", "checkedAt");

-- CreateIndex
CREATE INDEX "DocumentBackfillBatch_clubId_sourceTable_startedAt_idx" ON "DocumentBackfillBatch"("clubId", "sourceTable", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "POSLocation_clubId_code_key" ON "POSLocation"("clubId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "POSTerminal_clubId_code_key" ON "POSTerminal"("clubId", "code");

-- CreateIndex
CREATE INDEX "POSSession_clubId_status_idx" ON "POSSession"("clubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "POSSale_arChargeId_key" ON "POSSale"("arChargeId");

-- CreateIndex
CREATE UNIQUE INDEX "POSSale_refundOfSaleId_key" ON "POSSale"("refundOfSaleId");

-- CreateIndex
CREATE INDEX "POSSale_clubId_status_idx" ON "POSSale"("clubId", "status");

-- CreateIndex
CREATE INDEX "POSSale_clubId_saleDate_idx" ON "POSSale"("clubId", "saleDate");

-- CreateIndex
CREATE INDEX "POSSale_memberId_idx" ON "POSSale"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "POSSale_clubId_saleNumber_key" ON "POSSale"("clubId", "saleNumber");

-- CreateIndex
CREATE UNIQUE INDEX "POSSale_clubId_providerId_externalReference_key" ON "POSSale"("clubId", "providerId", "externalReference");

-- CreateIndex
CREATE INDEX "POSSaleLine_saleId_idx" ON "POSSaleLine"("saleId");

-- CreateIndex
CREATE INDEX "POSTaxLine_saleId_idx" ON "POSTaxLine"("saleId");

-- CreateIndex
CREATE INDEX "POSDiscount_saleId_idx" ON "POSDiscount"("saleId");

-- CreateIndex
CREATE INDEX "POSMenuCategory_clubId_locationId_isActive_sortOrder_idx" ON "POSMenuCategory"("clubId", "locationId", "isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "POSMenuCategory_clubId_locationId_name_key" ON "POSMenuCategory"("clubId", "locationId", "name");

-- CreateIndex
CREATE INDEX "POSMenuItem_clubId_categoryId_isActive_sortOrder_idx" ON "POSMenuItem"("clubId", "categoryId", "isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "POSMenuItem_clubId_categoryId_name_key" ON "POSMenuItem"("clubId", "categoryId", "name");

-- CreateIndex
CREATE INDEX "POSModifierGroup_clubId_menuItemId_isActive_sortOrder_idx" ON "POSModifierGroup"("clubId", "menuItemId", "isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "POSModifierGroup_clubId_menuItemId_label_key" ON "POSModifierGroup"("clubId", "menuItemId", "label");

-- CreateIndex
CREATE INDEX "POSModifierOption_clubId_groupId_isActive_sortOrder_idx" ON "POSModifierOption"("clubId", "groupId", "isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "POSCheckLineModifier_clubId_checkLineId_idx" ON "POSCheckLineModifier"("clubId", "checkLineId");

-- CreateIndex
CREATE INDEX "POSPrinter_clubId_role_isActive_idx" ON "POSPrinter"("clubId", "role", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "POSPrinter_clubId_name_key" ON "POSPrinter"("clubId", "name");

-- CreateIndex
CREATE INDEX "POSSaleChit_clubId_createdAt_idx" ON "POSSaleChit"("clubId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "POSSaleChit_saleId_type_key" ON "POSSaleChit"("saleId", "type");

-- CreateIndex
CREATE INDEX "POSSaleLineModifier_clubId_saleLineId_idx" ON "POSSaleLineModifier"("clubId", "saleLineId");

-- CreateIndex
CREATE INDEX "POSPayment_saleId_idx" ON "POSPayment"("saleId");

-- CreateIndex
CREATE INDEX "POSPayment_clubId_externalPaymentStatus_idx" ON "POSPayment"("clubId", "externalPaymentStatus");

-- CreateIndex
CREATE UNIQUE INDEX "POSCheck_posSaleId_key" ON "POSCheck"("posSaleId");

-- CreateIndex
CREATE INDEX "POSCheck_clubId_status_openedByUserId_idx" ON "POSCheck"("clubId", "status", "openedByUserId");

-- CreateIndex
CREATE INDEX "POSCheck_clubId_memberId_idx" ON "POSCheck"("clubId", "memberId");

-- CreateIndex
CREATE INDEX "POSCheck_clubId_locationId_status_idx" ON "POSCheck"("clubId", "locationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "POSCheck_clubId_checkNumber_key" ON "POSCheck"("clubId", "checkNumber");

-- CreateIndex
CREATE INDEX "POSCheckLine_checkId_status_idx" ON "POSCheckLine"("checkId", "status");

-- CreateIndex
CREATE INDEX "POSCheckLine_clubId_status_idx" ON "POSCheckLine"("clubId", "status");

-- CreateIndex
CREATE INDEX "POSChit_clubId_station_status_sentAt_idx" ON "POSChit"("clubId", "station", "status", "sentAt");

-- CreateIndex
CREATE INDEX "POSChit_clubId_station_status_fireAt_idx" ON "POSChit"("clubId", "station", "status", "fireAt");

-- CreateIndex
CREATE INDEX "POSChit_checkId_idx" ON "POSChit"("checkId");

-- CreateIndex
CREATE INDEX "POSChitLine_chitId_idx" ON "POSChitLine"("chitId");

-- CreateIndex
CREATE INDEX "POSChitLine_checkLineId_idx" ON "POSChitLine"("checkLineId");

-- CreateIndex
CREATE INDEX "POSCheckEvent_checkId_occurredAt_idx" ON "POSCheckEvent"("checkId", "occurredAt");

-- CreateIndex
CREATE INDEX "POSCheckEvent_clubId_type_occurredAt_idx" ON "POSCheckEvent"("clubId", "type", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "POSIntegrationProvider_clubId_key_key" ON "POSIntegrationProvider"("clubId", "key");

-- CreateIndex
CREATE INDEX "LLMCommentaryDraft_clubId_status_idx" ON "LLMCommentaryDraft"("clubId", "status");

-- CreateIndex
CREATE INDEX "LLMCommentaryDraft_clubId_subjectEntityType_subjectEntityId_idx" ON "LLMCommentaryDraft"("clubId", "subjectEntityType", "subjectEntityId");

-- CreateIndex
CREATE INDEX "BackgroundJob_queue_status_scheduledFor_idx" ON "BackgroundJob"("queue", "status", "scheduledFor");

-- CreateIndex
CREATE INDEX "BackgroundJob_clubId_kind_status_idx" ON "BackgroundJob"("clubId", "kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundJob_clubId_kind_idempotencyKey_key" ON "BackgroundJob"("clubId", "kind", "idempotencyKey");

-- CreateIndex
CREATE INDEX "JobRun_jobId_attemptNumber_idx" ON "JobRun"("jobId", "attemptNumber");

-- CreateIndex
CREATE INDEX "JobFailure_jobId_idx" ON "JobFailure"("jobId");

-- CreateIndex
CREATE INDEX "QueueHealth_queue_observedAt_idx" ON "QueueHealth"("queue", "observedAt");

-- CreateIndex
CREATE INDEX "POSWebhookEvent_clubId_status_receivedAt_idx" ON "POSWebhookEvent"("clubId", "status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "POSWebhookEvent_clubId_providerKey_externalEventId_key" ON "POSWebhookEvent"("clubId", "providerKey", "externalEventId");

-- CreateIndex
CREATE INDEX "POSSyncRun_clubId_providerKey_startedAt_idx" ON "POSSyncRun"("clubId", "providerKey", "startedAt");

-- CreateIndex
CREATE INDEX "POSImportError_clubId_providerKey_occurredAt_idx" ON "POSImportError"("clubId", "providerKey", "occurredAt");

-- CreateIndex
CREATE INDEX "POSMapping_clubId_providerKey_idx" ON "POSMapping"("clubId", "providerKey");

-- CreateIndex
CREATE UNIQUE INDEX "POSMapping_clubId_providerKey_kind_externalId_key" ON "POSMapping"("clubId", "providerKey", "kind", "externalId");

-- CreateIndex
CREATE INDEX "WebhookReplay_receivedAt_idx" ON "WebhookReplay"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookReplay_scope_nonce_key" ON "WebhookReplay"("scope", "nonce");

-- CreateIndex
CREATE UNIQUE INDEX "Course_clubId_code_key" ON "Course"("clubId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "CourseHole_courseId_holeNumber_key" ON "CourseHole"("courseId", "holeNumber");

-- CreateIndex
CREATE INDEX "TeeSheet_clubId_sheetDate_idx" ON "TeeSheet"("clubId", "sheetDate");

-- CreateIndex
CREATE UNIQUE INDEX "TeeSheet_clubId_courseId_sheetDate_key" ON "TeeSheet"("clubId", "courseId", "sheetDate");

-- CreateIndex
CREATE INDEX "TeeTime_clubId_startTime_idx" ON "TeeTime"("clubId", "startTime");

-- CreateIndex
CREATE UNIQUE INDEX "TeeTime_teeSheetId_startTime_startingTee_key" ON "TeeTime"("teeSheetId", "startTime", "startingTee");

-- CreateIndex
CREATE INDEX "TeeTimeBooking_clubId_primaryMemberId_status_idx" ON "TeeTimeBooking"("clubId", "primaryMemberId", "status");

-- CreateIndex
CREATE INDEX "TeeTimeBooking_teeTimeId_idx" ON "TeeTimeBooking"("teeTimeId");

-- CreateIndex
CREATE INDEX "TeeTimePlayer_teeTimeId_idx" ON "TeeTimePlayer"("teeTimeId");

-- CreateIndex
CREATE INDEX "TeeTimeGuest_bookingId_idx" ON "TeeTimeGuest"("bookingId");

-- CreateIndex
CREATE INDEX "TeeLottery_clubId_status_idx" ON "TeeLottery"("clubId", "status");

-- CreateIndex
CREATE INDEX "TeeLotteryEntry_clubId_lotteryId_status_idx" ON "TeeLotteryEntry"("clubId", "lotteryId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TeeLotteryEntry_lotteryId_memberId_key" ON "TeeLotteryEntry"("lotteryId", "memberId");

-- CreateIndex
CREATE INDEX "PaceOfPlayRecord_teeTimeId_idx" ON "PaceOfPlayRecord"("teeTimeId");

-- CreateIndex
CREATE INDEX "CartAssignment_clubId_resourceCode_idx" ON "CartAssignment"("clubId", "resourceCode");

-- CreateIndex
CREATE INDEX "HardwareDevice_clubId_kind_status_idx" ON "HardwareDevice"("clubId", "kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "HardwareDevice_clubId_serial_key" ON "HardwareDevice"("clubId", "serial");

-- CreateIndex
CREATE INDEX "DeviceEvent_clubId_deviceId_occurredAt_idx" ON "DeviceEvent"("clubId", "deviceId", "occurredAt");

-- CreateIndex
CREATE INDEX "DeviceEvent_clubId_eventType_occurredAt_idx" ON "DeviceEvent"("clubId", "eventType", "occurredAt");

-- CreateIndex
CREATE INDEX "DeviceStatus_deviceId_observedAt_idx" ON "DeviceStatus"("deviceId", "observedAt");

-- CreateIndex
CREATE INDEX "DeviceAssignment_clubId_deviceId_idx" ON "DeviceAssignment"("clubId", "deviceId");

-- CreateIndex
CREATE INDEX "DeviceAssignment_subjectType_subjectId_idx" ON "DeviceAssignment"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "FeatureFlag_key_isEnabled_idx" ON "FeatureFlag"("key", "isEnabled");

-- CreateIndex
CREATE UNIQUE INDEX "FeatureFlag_clubId_key_key" ON "FeatureFlag"("clubId", "key");

-- CreateIndex
CREATE INDEX "RateLimitBucket_scope_updatedAt_idx" ON "RateLimitBucket"("scope", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RateLimitBucket_scope_identifier_key" ON "RateLimitBucket"("scope", "identifier");

-- CreateIndex
CREATE INDEX "ObservabilityEvent_clubId_kind_occurredAt_idx" ON "ObservabilityEvent"("clubId", "kind", "occurredAt");

-- CreateIndex
CREATE INDEX "ObservabilityEvent_correlationId_idx" ON "ObservabilityEvent"("correlationId");

-- CreateIndex
CREATE INDEX "MetricCounter_clubId_name_idx" ON "MetricCounter"("clubId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "MetricCounter_name_labels_key" ON "MetricCounter"("name", "labels");

-- CreateIndex
CREATE INDEX "AuthAttempt_clubId_scope_occurredAt_idx" ON "AuthAttempt"("clubId", "scope", "occurredAt");

-- CreateIndex
CREATE INDEX "AuthAttempt_emailHash_scope_occurredAt_idx" ON "AuthAttempt"("emailHash", "scope", "occurredAt");

-- CreateIndex
CREATE INDEX "AccountLock_emailHash_status_idx" ON "AccountLock"("emailHash", "status");

-- CreateIndex
CREATE INDEX "AccountLock_clubId_status_idx" ON "AccountLock"("clubId", "status");

-- CreateIndex
CREATE INDEX "SuspiciousActivityEvent_clubId_kind_occurredAt_idx" ON "SuspiciousActivityEvent"("clubId", "kind", "occurredAt");

-- CreateIndex
CREATE INDEX "SuspiciousActivityEvent_emailHash_occurredAt_idx" ON "SuspiciousActivityEvent"("emailHash", "occurredAt");

-- CreateIndex
CREATE INDEX "WebPushSubscription_clubId_userId_isActive_idx" ON "WebPushSubscription"("clubId", "userId", "isActive");

-- CreateIndex
CREATE INDEX "WebPushSubscription_clubId_memberId_isActive_idx" ON "WebPushSubscription"("clubId", "memberId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "WebPushSubscription_endpoint_key" ON "WebPushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "Tournament_clubId_status_idx" ON "Tournament"("clubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Tournament_clubId_name_key" ON "Tournament"("clubId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "TournamentDivision_tournamentId_name_key" ON "TournamentDivision"("tournamentId", "name");

-- CreateIndex
CREATE INDEX "TournamentRegistration_clubId_tournamentId_status_idx" ON "TournamentRegistration"("clubId", "tournamentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TournamentRegistration_tournamentId_memberId_key" ON "TournamentRegistration"("tournamentId", "memberId");

-- CreateIndex
CREATE UNIQUE INDEX "TournamentTeam_tournamentId_name_key" ON "TournamentTeam"("tournamentId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "TournamentRound_tournamentId_roundNumber_key" ON "TournamentRound"("tournamentId", "roundNumber");

-- CreateIndex
CREATE INDEX "TournamentMatch_tournamentId_roundId_idx" ON "TournamentMatch"("tournamentId", "roundId");

-- CreateIndex
CREATE INDEX "TournamentScore_tournamentId_registrationId_idx" ON "TournamentScore"("tournamentId", "registrationId");

-- CreateIndex
CREATE UNIQUE INDEX "TournamentScore_roundId_registrationId_holeNumber_key" ON "TournamentScore"("roundId", "registrationId", "holeNumber");

-- CreateIndex
CREATE INDEX "TournamentLeaderboard_tournamentId_positionRank_idx" ON "TournamentLeaderboard"("tournamentId", "positionRank");

-- CreateIndex
CREATE UNIQUE INDEX "TournamentLeaderboard_tournamentId_registrationId_key" ON "TournamentLeaderboard"("tournamentId", "registrationId");

-- CreateIndex
CREATE INDEX "TournamentPayoutPrize_tournamentId_rank_idx" ON "TournamentPayoutPrize"("tournamentId", "rank");

-- CreateIndex
CREATE INDEX "TournamentCommunication_tournamentId_idx" ON "TournamentCommunication"("tournamentId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyPrefix_key" ON "ApiKey"("keyPrefix");

-- CreateIndex
CREATE INDEX "ApiKey_clubId_status_idx" ON "ApiKey"("clubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKeyPermission_apiKeyId_permission_key" ON "ApiKeyPermission"("apiKeyId", "permission");

-- CreateIndex
CREATE INDEX "ApiRequestLog_clubId_occurredAt_idx" ON "ApiRequestLog"("clubId", "occurredAt");

-- CreateIndex
CREATE INDEX "ApiRequestLog_apiKeyId_occurredAt_idx" ON "ApiRequestLog"("apiKeyId", "occurredAt");

-- CreateIndex
CREATE INDEX "WebhookSubscription_clubId_status_idx" ON "WebhookSubscription"("clubId", "status");

-- CreateIndex
CREATE INDEX "WebhookDelivery_subscriptionId_status_idx" ON "WebhookDelivery"("subscriptionId", "status");

-- CreateIndex
CREATE INDEX "WebhookDelivery_clubId_eventType_createdAt_idx" ON "WebhookDelivery"("clubId", "eventType", "createdAt");

-- CreateIndex
CREATE INDEX "PilotReadinessItem_clubId_category_status_idx" ON "PilotReadinessItem"("clubId", "category", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PilotReadinessItem_clubId_key_key" ON "PilotReadinessItem"("clubId", "key");

-- CreateIndex
CREATE INDEX "PushDeliveryAttempt_clubId_status_attemptedAt_idx" ON "PushDeliveryAttempt"("clubId", "status", "attemptedAt");

-- CreateIndex
CREATE INDEX "PushDeliveryAttempt_subscriptionId_idx" ON "PushDeliveryAttempt"("subscriptionId");

-- CreateIndex
CREATE INDEX "PushCampaign_clubId_status_idx" ON "PushCampaign"("clubId", "status");

-- CreateIndex
CREATE INDEX "TournamentPairing_tournamentId_roundId_idx" ON "TournamentPairing"("tournamentId", "roundId");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPlan_key_key" ON "SubscriptionPlan"("key");

-- CreateIndex
CREATE UNIQUE INDEX "ClubSubscription_clubId_key" ON "ClubSubscription"("clubId");

-- CreateIndex
CREATE INDEX "ClubSubscription_status_idx" ON "ClubSubscription"("status");

-- CreateIndex
CREATE INDEX "UsageMetric_clubId_kind_periodLabel_idx" ON "UsageMetric"("clubId", "kind", "periodLabel");

-- CreateIndex
CREATE UNIQUE INDEX "UsageMetric_clubId_periodLabel_kind_key" ON "UsageMetric"("clubId", "periodLabel", "kind");

-- CreateIndex
CREATE INDEX "BillingCycle_clubId_status_idx" ON "BillingCycle"("clubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BillingCycle_clubId_periodLabel_key" ON "BillingCycle"("clubId", "periodLabel");

-- CreateIndex
CREATE INDEX "WebhookSecretVersion_subscriptionId_state_idx" ON "WebhookSecretVersion"("subscriptionId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookSecretVersion_subscriptionId_versionNumber_key" ON "WebhookSecretVersion"("subscriptionId", "versionNumber");

-- CreateIndex
CREATE INDEX "WebhookSecretRotation_subscriptionId_occurredAt_idx" ON "WebhookSecretRotation"("subscriptionId", "occurredAt");

-- CreateIndex
CREATE INDEX "POSMappingHistory_clubId_providerKey_occurredAt_idx" ON "POSMappingHistory"("clubId", "providerKey", "occurredAt");

-- CreateIndex
CREATE INDEX "TournamentScoreDraft_clubId_tournamentId_status_idx" ON "TournamentScoreDraft"("clubId", "tournamentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TournamentScoreDraft_roundId_registrationId_key" ON "TournamentScoreDraft"("roundId", "registrationId");

-- CreateIndex
CREATE INDEX "TournamentScoreConflict_clubId_draftId_resolution_idx" ON "TournamentScoreConflict"("clubId", "draftId", "resolution");

-- CreateIndex
CREATE INDEX "TournamentScoreCorrection_tournamentId_registrationId_idx" ON "TournamentScoreCorrection"("tournamentId", "registrationId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingCustomer_clubId_key" ON "BillingCustomer"("clubId");

-- CreateIndex
CREATE INDEX "BillingSubscription_clubId_status_idx" ON "BillingSubscription"("clubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BillingSubscription_provider_externalId_key" ON "BillingSubscription"("provider", "externalId");

-- CreateIndex
CREATE INDEX "BillingInvoice_clubId_status_idx" ON "BillingInvoice"("clubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BillingInvoice_provider_externalId_key" ON "BillingInvoice"("provider", "externalId");

-- CreateIndex
CREATE INDEX "BillingPaymentAttempt_clubId_status_occurredAt_idx" ON "BillingPaymentAttempt"("clubId", "status", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingPaymentAttempt_provider_externalId_key" ON "BillingPaymentAttempt"("provider", "externalId");

-- CreateIndex
CREATE INDEX "BillingWebhookEvent_provider_status_receivedAt_idx" ON "BillingWebhookEvent"("provider", "status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingWebhookEvent_provider_externalEventId_key" ON "BillingWebhookEvent"("provider", "externalEventId");

-- CreateIndex
CREATE UNIQUE INDEX "MfaFactor_userId_kind_key" ON "MfaFactor"("userId", "kind");

-- CreateIndex
CREATE INDEX "RecoveryCode_userId_idx" ON "RecoveryCode"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TrustedDevice_tokenHash_key" ON "TrustedDevice"("tokenHash");

-- CreateIndex
CREATE INDEX "TrustedDevice_userId_expiresAt_idx" ON "TrustedDevice"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "SsoProvider_clubId_kind_key" ON "SsoProvider"("clubId", "kind");

-- CreateIndex
CREATE INDEX "SsoLoginAttempt_clubId_occurredAt_idx" ON "SsoLoginAttempt"("clubId", "occurredAt");

-- CreateIndex
CREATE INDEX "SecretAccessLog_clubId_scope_occurredAt_idx" ON "SecretAccessLog"("clubId", "scope", "occurredAt");

-- CreateIndex
CREATE INDEX "SecretAccessLog_occurredAt_idx" ON "SecretAccessLog"("occurredAt");

-- CreateIndex
CREATE INDEX "KeyRotationEvent_clubId_scope_startedAt_idx" ON "KeyRotationEvent"("clubId", "scope", "startedAt");

-- CreateIndex
CREATE INDEX "EncryptedSecretMetadata_clubId_scope_idx" ON "EncryptedSecretMetadata"("clubId", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "EncryptedSecretMetadata_scope_secretReference_key" ON "EncryptedSecretMetadata"("scope", "secretReference");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceApp_key_key" ON "MarketplaceApp"("key");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceApp_clientId_key" ON "MarketplaceApp"("clientId");

-- CreateIndex
CREATE INDEX "MarketplaceApp_status_idx" ON "MarketplaceApp"("status");

-- CreateIndex
CREATE INDEX "InstalledApp_clubId_status_idx" ON "InstalledApp"("clubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "InstalledApp_clubId_appId_key" ON "InstalledApp"("clubId", "appId");

-- CreateIndex
CREATE INDEX "AppPermission_clubId_permission_idx" ON "AppPermission"("clubId", "permission");

-- CreateIndex
CREATE UNIQUE INDEX "AppPermission_installedAppId_permission_key" ON "AppPermission"("installedAppId", "permission");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthGrant_accessTokenHash_key" ON "OAuthGrant"("accessTokenHash");

-- CreateIndex
CREATE INDEX "OAuthGrant_clubId_status_idx" ON "OAuthGrant"("clubId", "status");

-- CreateIndex
CREATE INDEX "OAuthGrant_appId_status_idx" ON "OAuthGrant"("appId", "status");

-- CreateIndex
CREATE INDEX "AppWebhookSubscription_clubId_installedAppId_idx" ON "AppWebhookSubscription"("clubId", "installedAppId");

-- CreateIndex
CREATE INDEX "AccessReview_clubId_status_idx" ON "AccessReview"("clubId", "status");

-- CreateIndex
CREATE INDEX "AccessReviewItem_reviewId_decision_idx" ON "AccessReviewItem"("reviewId", "decision");

-- CreateIndex
CREATE INDEX "ComplianceEvidence_clubId_kind_generatedAt_idx" ON "ComplianceEvidence"("clubId", "kind", "generatedAt");

-- CreateIndex
CREATE INDEX "PolicyAcknowledgement_clubId_status_idx" ON "PolicyAcknowledgement"("clubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyAcknowledgement_userId_policyKey_policyVersion_key" ON "PolicyAcknowledgement"("userId", "policyKey", "policyVersion");

-- CreateIndex
CREATE UNIQUE INDEX "CircuitBreakerState_resourceKey_key" ON "CircuitBreakerState"("resourceKey");

-- CreateIndex
CREATE INDEX "CircuitBreakerState_clubId_state_idx" ON "CircuitBreakerState"("clubId", "state");

-- CreateIndex
CREATE INDEX "PilotOnboardingProject_status_idx" ON "PilotOnboardingProject"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PilotOnboardingProject_clubId_name_key" ON "PilotOnboardingProject"("clubId", "name");

-- CreateIndex
CREATE INDEX "PilotOnboardingStep_clubId_status_idx" ON "PilotOnboardingStep"("clubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PilotOnboardingStep_projectId_stepKey_key" ON "PilotOnboardingStep"("projectId", "stepKey");

-- CreateIndex
CREATE INDEX "PilotOnboardingTask_projectId_status_idx" ON "PilotOnboardingTask"("projectId", "status");

-- CreateIndex
CREATE INDEX "PilotOnboardingTask_clubId_status_idx" ON "PilotOnboardingTask"("clubId", "status");

-- CreateIndex
CREATE INDEX "PilotOnboardingNote_projectId_createdAt_idx" ON "PilotOnboardingNote"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "PilotOnboardingBlocker_projectId_status_idx" ON "PilotOnboardingBlocker"("projectId", "status");

-- CreateIndex
CREATE INDEX "PilotOnboardingBlocker_clubId_status_idx" ON "PilotOnboardingBlocker"("clubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PilotGoLiveSignoff_projectId_category_key" ON "PilotGoLiveSignoff"("projectId", "category");

-- CreateIndex
CREATE INDEX "ImportBatch_clubId_domain_status_idx" ON "ImportBatch"("clubId", "domain", "status");

-- CreateIndex
CREATE INDEX "ImportBatch_clubId_createdAt_idx" ON "ImportBatch"("clubId", "createdAt");

-- CreateIndex
CREATE INDEX "ImportRow_batchId_status_idx" ON "ImportRow"("batchId", "status");

-- CreateIndex
CREATE INDEX "ImportRow_clubId_batchId_idx" ON "ImportRow"("clubId", "batchId");

-- CreateIndex
CREATE INDEX "ImportError_batchId_idx" ON "ImportError"("batchId");

-- CreateIndex
CREATE INDEX "OpeningBalanceSet_clubId_status_idx" ON "OpeningBalanceSet"("clubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OpeningBalanceSet_clubId_label_key" ON "OpeningBalanceSet"("clubId", "label");

-- CreateIndex
CREATE UNIQUE INDEX "MemberPortalInvite_tokenHash_key" ON "MemberPortalInvite"("tokenHash");

-- CreateIndex
CREATE INDEX "MemberPortalInvite_clubId_status_idx" ON "MemberPortalInvite"("clubId", "status");

-- CreateIndex
CREATE INDEX "MemberPortalInvite_memberId_idx" ON "MemberPortalInvite"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "ClubTrainingMode_clubId_key" ON "ClubTrainingMode"("clubId");

-- CreateIndex
CREATE INDEX "TrainingScenario_clubId_roleKey_idx" ON "TrainingScenario"("clubId", "roleKey");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingScenario_clubId_key_key" ON "TrainingScenario"("clubId", "key");

-- CreateIndex
CREATE INDEX "SupportAccessGrant_clubId_status_idx" ON "SupportAccessGrant"("clubId", "status");

-- CreateIndex
CREATE INDEX "SupportAccessGrant_supportUserId_status_idx" ON "SupportAccessGrant"("supportUserId", "status");

-- CreateIndex
CREATE INDEX "SupportSession_clubId_startedAt_idx" ON "SupportSession"("clubId", "startedAt");

-- CreateIndex
CREATE INDEX "SupportSession_supportUserId_startedAt_idx" ON "SupportSession"("supportUserId", "startedAt");

-- CreateIndex
CREATE INDEX "SupportActionLog_sessionId_occurredAt_idx" ON "SupportActionLog"("sessionId", "occurredAt");

-- CreateIndex
CREATE INDEX "Incident_clubId_status_idx" ON "Incident"("clubId", "status");

-- CreateIndex
CREATE INDEX "Incident_severity_status_idx" ON "Incident"("severity", "status");

-- CreateIndex
CREATE INDEX "IncidentTimelineEvent_incidentId_occurredAt_idx" ON "IncidentTimelineEvent"("incidentId", "occurredAt");

-- CreateIndex
CREATE INDEX "SupportTicket_clubId_status_idx" ON "SupportTicket"("clubId", "status");

-- CreateIndex
CREATE INDEX "SupportTicket_assignedToUserId_status_idx" ON "SupportTicket"("assignedToUserId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ClubDomain_hostname_key" ON "ClubDomain"("hostname");

-- CreateIndex
CREATE INDEX "ClubDomain_clubId_status_idx" ON "ClubDomain"("clubId", "status");

-- CreateIndex
CREATE INDEX "ClubDomain_status_idx" ON "ClubDomain"("status");

-- CreateIndex
CREATE INDEX "KnownIssue_status_publishedAt_idx" ON "KnownIssue"("status", "publishedAt");

-- CreateIndex
CREATE INDEX "ImportTemplate_clubId_domain_status_idx" ON "ImportTemplate"("clubId", "domain", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ImportTemplate_scope_key_version_key" ON "ImportTemplate"("scope", "key", "version");

-- CreateIndex
CREATE INDEX "EmailDeliveryEvent_clubId_email_occurredAt_idx" ON "EmailDeliveryEvent"("clubId", "email", "occurredAt");

-- CreateIndex
CREATE INDEX "EmailDeliveryEvent_kind_occurredAt_idx" ON "EmailDeliveryEvent"("kind", "occurredAt");

-- CreateIndex
CREATE INDEX "EmailDeliveryEvent_inviteId_idx" ON "EmailDeliveryEvent"("inviteId");

-- CreateIndex
CREATE INDEX "EmailSuppression_email_idx" ON "EmailSuppression"("email");

-- CreateIndex
CREATE UNIQUE INDEX "EmailSuppression_clubId_email_key" ON "EmailSuppression"("clubId", "email");

-- CreateIndex
CREATE INDEX "PilotRetrospective_clubId_status_idx" ON "PilotRetrospective"("clubId", "status");

-- CreateIndex
CREATE INDEX "RetrospectiveItem_retrospectiveId_idx" ON "RetrospectiveItem"("retrospectiveId");

-- CreateIndex
CREATE INDEX "RetrospectiveItem_clubId_category_idx" ON "RetrospectiveItem"("clubId", "category");

-- CreateIndex
CREATE INDEX "RetrospectiveAction_retrospectiveId_status_idx" ON "RetrospectiveAction"("retrospectiveId", "status");

-- CreateIndex
CREATE INDEX "RetrospectiveAction_clubId_status_idx" ON "RetrospectiveAction"("clubId", "status");

-- CreateIndex
CREATE INDEX "PilotMetricSnapshot_clubId_capturedAt_idx" ON "PilotMetricSnapshot"("clubId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "HospitalitySurveyInvitation_tokenHash_key" ON "HospitalitySurveyInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "HospitalitySurveyInvitation_clubId_posCheckId_idx" ON "HospitalitySurveyInvitation"("clubId", "posCheckId");

-- CreateIndex
CREATE INDEX "HospitalitySurveyInvitation_clubId_status_idx" ON "HospitalitySurveyInvitation"("clubId", "status");

-- CreateIndex
CREATE INDEX "HospitalitySurveyInvitation_clubId_memberId_idx" ON "HospitalitySurveyInvitation"("clubId", "memberId");

-- CreateIndex
CREATE INDEX "HospitalitySurveyInvitation_clubId_departmentKey_status_idx" ON "HospitalitySurveyInvitation"("clubId", "departmentKey", "status");

-- CreateIndex
CREATE UNIQUE INDEX "HospitalitySurveyInvitation_clubId_posSettlementGroupId_key" ON "HospitalitySurveyInvitation"("clubId", "posSettlementGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "HospitalitySurveyResponse_invitationId_key" ON "HospitalitySurveyResponse"("invitationId");

-- CreateIndex
CREATE INDEX "HospitalitySurveyResponse_clubId_submittedAt_idx" ON "HospitalitySurveyResponse"("clubId", "submittedAt");

-- CreateIndex
CREATE INDEX "HospitalitySurveyResponse_clubId_serviceRecoveryStatus_idx" ON "HospitalitySurveyResponse"("clubId", "serviceRecoveryStatus");

-- CreateIndex
CREATE INDEX "HospitalitySurveyResponse_clubId_rating_submittedAt_idx" ON "HospitalitySurveyResponse"("clubId", "rating", "submittedAt");

-- CreateIndex
CREATE INDEX "DepartmentNotificationRule_clubId_active_idx" ON "DepartmentNotificationRule"("clubId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "DepartmentNotificationRule_clubId_departmentKey_key" ON "DepartmentNotificationRule"("clubId", "departmentKey");

-- CreateIndex
CREATE INDEX "DiningArea_clubId_active_sortOrder_idx" ON "DiningArea"("clubId", "active", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "DiningArea_clubId_name_key" ON "DiningArea"("clubId", "name");

-- CreateIndex
CREATE INDEX "DiningTable_clubId_diningAreaId_status_idx" ON "DiningTable"("clubId", "diningAreaId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DiningTable_clubId_tableNumber_key" ON "DiningTable"("clubId", "tableNumber");

-- CreateIndex
CREATE INDEX "DiningFloorPlan_clubId_diningAreaId_status_idx" ON "DiningFloorPlan"("clubId", "diningAreaId", "status");

-- CreateIndex
CREATE INDEX "DiningFloorPlanTable_clubId_floorPlanId_idx" ON "DiningFloorPlanTable"("clubId", "floorPlanId");

-- CreateIndex
CREATE UNIQUE INDEX "DiningReservation_noShowFeeChargeId_key" ON "DiningReservation"("noShowFeeChargeId");

-- CreateIndex
CREATE INDEX "DiningReservation_clubId_reservationDate_idx" ON "DiningReservation"("clubId", "reservationDate");

-- CreateIndex
CREATE INDEX "DiningReservation_clubId_status_reservationDate_idx" ON "DiningReservation"("clubId", "status", "reservationDate");

-- CreateIndex
CREATE INDEX "DiningReservation_clubId_memberId_reservationDate_idx" ON "DiningReservation"("clubId", "memberId", "reservationDate");

-- CreateIndex
CREATE INDEX "DiningReservation_clubId_tableId_status_idx" ON "DiningReservation"("clubId", "tableId", "status");

-- CreateIndex
CREATE INDEX "DiningReservationCheckLink_clubId_reservationId_idx" ON "DiningReservationCheckLink"("clubId", "reservationId");

-- CreateIndex
CREATE UNIQUE INDEX "DiningReservationCheckLink_clubId_posCheckId_key" ON "DiningReservationCheckLink"("clubId", "posCheckId");

-- CreateIndex
CREATE UNIQUE INDEX "ReservationSettings_clubId_key" ON "ReservationSettings"("clubId");

-- CreateIndex
CREATE UNIQUE INDEX "POSSettlementGroup_posSaleId_key" ON "POSSettlementGroup"("posSaleId");

-- CreateIndex
CREATE INDEX "POSSettlementGroup_clubId_status_idx" ON "POSSettlementGroup"("clubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "POSSettlementGroup_posCheckId_label_key" ON "POSSettlementGroup"("posCheckId", "label");

-- CreateIndex
CREATE INDEX "POSCheckSeat_clubId_posCheckId_idx" ON "POSCheckSeat"("clubId", "posCheckId");

-- CreateIndex
CREATE UNIQUE INDEX "POSCheckSeat_posCheckId_seatNumber_key" ON "POSCheckSeat"("posCheckId", "seatNumber");

-- CreateIndex
CREATE UNIQUE INDEX "POSQRPayment_posSaleId_key" ON "POSQRPayment"("posSaleId");

-- CreateIndex
CREATE INDEX "POSQRPayment_clubId_posCheckId_idx" ON "POSQRPayment"("clubId", "posCheckId");

-- CreateIndex
CREATE INDEX "POSQRPayment_clubId_status_idx" ON "POSQRPayment"("clubId", "status");

-- CreateIndex
CREATE INDEX "ReportingLedgerBatch_clubId_state_idx" ON "ReportingLedgerBatch"("clubId", "state");

-- CreateIndex
CREATE INDEX "ReportingLedgerBatch_clubId_openedAt_idx" ON "ReportingLedgerBatch"("clubId", "openedAt");

-- CreateIndex
CREATE INDEX "ReportingLedgerSnapshot_clubId_entityKind_asOf_idx" ON "ReportingLedgerSnapshot"("clubId", "entityKind", "asOf");

-- CreateIndex
CREATE INDEX "ReportingLedgerSnapshot_clubId_entityKind_periodEnd_idx" ON "ReportingLedgerSnapshot"("clubId", "entityKind", "periodEnd");

-- CreateIndex
CREATE INDEX "ReportingLedgerSnapshot_clubId_entityKind_fiscalYearLabel_idx" ON "ReportingLedgerSnapshot"("clubId", "entityKind", "fiscalYearLabel");

-- CreateIndex
CREATE INDEX "ReportingLedgerSnapshot_clubId_entityKind_batchState_idx" ON "ReportingLedgerSnapshot"("clubId", "entityKind", "batchState");

-- CreateIndex
CREATE INDEX "ReportingLedgerSnapshot_clubId_payloadHash_idx" ON "ReportingLedgerSnapshot"("clubId", "payloadHash");

-- CreateIndex
CREATE INDEX "ReportingLedgerSnapshot_importBatchId_idx" ON "ReportingLedgerSnapshot"("importBatchId");

-- CreateIndex
CREATE INDEX "WorkIntakeItem_clubId_status_displayReceivedAt_idx" ON "WorkIntakeItem"("clubId", "status", "displayReceivedAt");

-- CreateIndex
CREATE INDEX "WorkIntakeItem_ownerUserId_status_idx" ON "WorkIntakeItem"("ownerUserId", "status");

-- CreateIndex
CREATE INDEX "WorkIntakeItem_clubId_updatedAt_idx" ON "WorkIntakeItem"("clubId", "updatedAt");

-- CreateIndex
CREATE INDEX "WorkIntakeActivity_workIntakeItemId_createdAt_idx" ON "WorkIntakeActivity"("workIntakeItemId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailWorkIntakeOrigin_emailMessageId_role_idx" ON "EmailWorkIntakeOrigin"("emailMessageId", "role");

-- CreateIndex
CREATE INDEX "EmailWorkIntakeOrigin_clubId_idx" ON "EmailWorkIntakeOrigin"("clubId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailWorkIntakeOrigin_workIntakeItemId_emailMessageId_key" ON "EmailWorkIntakeOrigin"("workIntakeItemId", "emailMessageId");

-- CreateIndex
CREATE INDEX "MailboxConnection_clubId_status_idx" ON "MailboxConnection"("clubId", "status");

-- CreateIndex
CREATE INDEX "MailboxConnection_microsoftTenantId_externalUserId_idx" ON "MailboxConnection"("microsoftTenantId", "externalUserId");

-- CreateIndex
CREATE UNIQUE INDEX "MailboxConnection_userId_clubId_provider_externalUserId_key" ON "MailboxConnection"("userId", "clubId", "provider", "externalUserId");

-- CreateIndex
CREATE INDEX "MailboxAccess_userId_revokedAt_idx" ON "MailboxAccess"("userId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MailboxAccess_mailboxConnectionId_userId_role_key" ON "MailboxAccess"("mailboxConnectionId", "userId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "GraphSubscription_microsoftSubscriptionId_key" ON "GraphSubscription"("microsoftSubscriptionId");

-- CreateIndex
CREATE INDEX "GraphSubscription_expirationDateTime_idx" ON "GraphSubscription"("expirationDateTime");

-- CreateIndex
CREATE INDEX "GraphSubscription_mailboxConnectionId_lifecycleState_idx" ON "GraphSubscription"("mailboxConnectionId", "lifecycleState");

-- CreateIndex
CREATE INDEX "EmailMessage_clubId_receivedAt_idx" ON "EmailMessage"("clubId", "receivedAt");

-- CreateIndex
CREATE INDEX "EmailMessage_conversationId_idx" ON "EmailMessage"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailMessage_mailboxConnectionId_graphMessageId_key" ON "EmailMessage"("mailboxConnectionId", "graphMessageId");

-- CreateIndex
CREATE INDEX "MailboxSyncRun_mailboxConnectionId_queuedAt_idx" ON "MailboxSyncRun"("mailboxConnectionId", "queuedAt");

-- CreateIndex
CREATE INDEX "MailboxSyncRun_clubId_queuedAt_idx" ON "MailboxSyncRun"("clubId", "queuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MailboxOAuthTransaction_state_key" ON "MailboxOAuthTransaction"("state");

-- CreateIndex
CREATE INDEX "MailboxOAuthTransaction_userId_clubId_createdAt_idx" ON "MailboxOAuthTransaction"("userId", "clubId", "createdAt");

-- CreateIndex
CREATE INDEX "MailboxOAuthTransaction_expiresAt_idx" ON "MailboxOAuthTransaction"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailAttachment_emailMessageId_graphAttachmentId_key" ON "EmailAttachment"("emailMessageId", "graphAttachmentId");

-- AddForeignKey
ALTER TABLE "ClubProfile" ADD CONSTRAINT "ClubProfile_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleKey_fkey" FOREIGN KEY ("roleKey") REFERENCES "Role"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionKey_fkey" FOREIGN KEY ("permissionKey") REFERENCES "Permission"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserClubRole" ADD CONSTRAINT "UserClubRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserClubRole" ADD CONSTRAINT "UserClubRole_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserClubRole" ADD CONSTRAINT "UserClubRole_roleKey_fkey" FOREIGN KEY ("roleKey") REFERENCES "Role"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Applicant" ADD CONSTRAINT "Applicant_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Applicant" ADD CONSTRAINT "Applicant_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationHouseholdMember" ADD CONSTRAINT "ApplicationHouseholdMember_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationHouseholdMember" ADD CONSTRAINT "ApplicationHouseholdMember_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationDocument" ADD CONSTRAINT "ApplicationDocument_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationDocument" ADD CONSTRAINT "ApplicationDocument_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationDraftToken" ADD CONSTRAINT "ApplicationDraftToken_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationDraftToken" ADD CONSTRAINT "ApplicationDraftToken_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberAccount" ADD CONSTRAINT "MemberAccount_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberAccount" ADD CONSTRAINT "MemberAccount_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MemberAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_postedByUserId_fkey" FOREIGN KEY ("postedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_voidedByUserId_fkey" FOREIGN KEY ("voidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "Charge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MemberAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_paymentMethodId_fkey" FOREIGN KEY ("paymentMethodId") REFERENCES "PaymentMethod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_retryOfId_fkey" FOREIGN KEY ("retryOfId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_postedByUserId_fkey" FOREIGN KEY ("postedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_voidedByUserId_fkey" FOREIGN KEY ("voidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentMethod" ADD CONSTRAINT "PaymentMethod_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentMethod" ADD CONSTRAINT "PaymentMethod_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancingAgreement" ADD CONSTRAINT "FinancingAgreement_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancingAgreement" ADD CONSTRAINT "FinancingAgreement_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancingAgreement" ADD CONSTRAINT "FinancingAgreement_currentDocumentId_fkey" FOREIGN KEY ("currentDocumentId") REFERENCES "FinancingDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancingDocument" ADD CONSTRAINT "FinancingDocument_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancingDocument" ADD CONSTRAINT "FinancingDocument_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "FinancingAgreement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancingPayment" ADD CONSTRAINT "FinancingPayment_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancingPayment" ADD CONSTRAINT "FinancingPayment_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "FinancingAgreement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancingPayment" ADD CONSTRAINT "FinancingPayment_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "FinancingPaymentSchedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancingPaymentSchedule" ADD CONSTRAINT "FinancingPaymentSchedule_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancingPaymentSchedule" ADD CONSTRAINT "FinancingPaymentSchedule_financingAgreementId_fkey" FOREIGN KEY ("financingAgreementId") REFERENCES "FinancingAgreement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionNotice" ADD CONSTRAINT "CollectionNotice_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionNotice" ADD CONSTRAINT "CollectionNotice_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionNotice" ADD CONSTRAINT "CollectionNotice_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "CollectionNoticeTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionNoticeTemplate" ADD CONSTRAINT "CollectionNoticeTemplate_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionStage" ADD CONSTRAINT "CollectionStage_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionAction" ADD CONSTRAINT "CollectionAction_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionAction" ADD CONSTRAINT "CollectionAction_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "CollectionStage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubMilestone" ADD CONSTRAINT "ClubMilestone_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberPreference" ADD CONSTRAINT "MemberPreference_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberPreference" ADD CONSTRAINT "MemberPreference_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DashboardWidget" ADD CONSTRAINT "DashboardWidget_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DashboardWidget" ADD CONSTRAINT "DashboardWidget_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubEvent" ADD CONSTRAINT "ClubEvent_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventRegistration" ADD CONSTRAINT "EventRegistration_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventRegistration" ADD CONSTRAINT "EventRegistration_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "ClubEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventRegistration" ADD CONSTRAINT "EventRegistration_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingChecklistItem" ADD CONSTRAINT "OnboardingChecklistItem_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingChecklistItem" ADD CONSTRAINT "OnboardingChecklistItem_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncentiveCredit" ADD CONSTRAINT "IncentiveCredit_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncentiveCredit" ADD CONSTRAINT "IncentiveCredit_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubWidgetConfig" ADD CONSTRAINT "ClubWidgetConfig_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberHouseholdMember" ADD CONSTRAINT "MemberHouseholdMember_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberHouseholdMember" ADD CONSTRAINT "MemberHouseholdMember_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberDocument" ADD CONSTRAINT "MemberDocument_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberDocument" ADD CONSTRAINT "MemberDocument_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubAnnouncement" ADD CONSTRAINT "ClubAnnouncement_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountAdjustment" ADD CONSTRAINT "AccountAdjustment_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountAdjustment" ADD CONSTRAINT "AccountAdjustment_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountAdjustment" ADD CONSTRAINT "AccountAdjustment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MemberAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountAdjustment" ADD CONSTRAINT "AccountAdjustment_postedByUserId_fkey" FOREIGN KEY ("postedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountAdjustment" ADD CONSTRAINT "AccountAdjustment_voidedByUserId_fkey" FOREIGN KEY ("voidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountNote" ADD CONSTRAINT "AccountNote_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountNote" ADD CONSTRAINT "AccountNote_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountNote" ADD CONSTRAINT "AccountNote_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentPromise" ADD CONSTRAINT "PaymentPromise_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentPromise" ADD CONSTRAINT "PaymentPromise_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Statement" ADD CONSTRAINT "Statement_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Statement" ADD CONSTRAINT "Statement_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_parentDepartmentId_fkey" FOREIGN KEY ("parentDepartmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostCenter" ADD CONSTRAINT "CostCenter_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostCenter" ADD CONSTRAINT "CostCenter_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialStatementGroup" ADD CONSTRAINT "FinancialStatementGroup_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialStatementGroup" ADD CONSTRAINT "FinancialStatementGroup_parentGroupId_fkey" FOREIGN KEY ("parentGroupId") REFERENCES "FinancialStatementGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountCategory" ADD CONSTRAINT "AccountCategory_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "AccountCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_parentAccountId_fkey" FOREIGN KEY ("parentAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_fsGroupId_fkey" FOREIGN KEY ("fsGroupId") REFERENCES "FinancialStatementGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_defaultDepartmentId_fkey" FOREIGN KEY ("defaultDepartmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountDepartment" ADD CONSTRAINT "AccountDepartment_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountDepartment" ADD CONSTRAINT "AccountDepartment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountDepartment" ADD CONSTRAINT "AccountDepartment_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FiscalYear" ADD CONSTRAINT "FiscalYear_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FiscalPeriod" ADD CONSTRAINT "FiscalPeriod_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FiscalPeriod" ADD CONSTRAINT "FiscalPeriod_fiscalYearId_fkey" FOREIGN KEY ("fiscalYearId") REFERENCES "FiscalYear"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalBatch" ADD CONSTRAINT "JournalBatch_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "JournalBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "FiscalPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntryLine" ADD CONSTRAINT "JournalEntryLine_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntryLine" ADD CONSTRAINT "JournalEntryLine_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntryLine" ADD CONSTRAINT "JournalEntryLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntryLine" ADD CONSTRAINT "JournalEntryLine_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntryLine" ADD CONSTRAINT "JournalEntryLine_costCenterId_fkey" FOREIGN KEY ("costCenterId") REFERENCES "CostCenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringJournal" ADD CONSTRAINT "RecurringJournal_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalAttachment" ADD CONSTRAINT "JournalAttachment_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalAttachment" ADD CONSTRAINT "JournalAttachment_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_defaultExpenseAccountId_fkey" FOREIGN KEY ("defaultExpenseAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_defaultDepartmentId_fkey" FOREIGN KEY ("defaultDepartmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorContact" ADD CONSTRAINT "VendorContact_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorContact" ADD CONSTRAINT "VendorContact_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorBankingProfile" ADD CONSTRAINT "VendorBankingProfile_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorBankingProfile" ADD CONSTRAINT "VendorBankingProfile_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PennyTest" ADD CONSTRAINT "PennyTest_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PennyTest" ADD CONSTRAINT "PennyTest_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PennyTest" ADD CONSTRAINT "PennyTest_bankingProfileId_fkey" FOREIGN KEY ("bankingProfileId") REFERENCES "VendorBankingProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorDocument" ADD CONSTRAINT "VendorDocument_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorDocument" ADD CONSTRAINT "VendorDocument_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorRiskFlag" ADD CONSTRAINT "VendorRiskFlag_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorRiskFlag" ADD CONSTRAINT "VendorRiskFlag_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxCode" ADD CONSTRAINT "TaxCode_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxCode" ADD CONSTRAINT "TaxCode_recoverableAccountId_fkey" FOREIGN KEY ("recoverableAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxCode" ADD CONSTRAINT "TaxCode_payableAccountId_fkey" FOREIGN KEY ("payableAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalPolicy" ADD CONSTRAINT "ApprovalPolicy_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "ApprovalPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalDecision" ADD CONSTRAINT "ApprovalDecision_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalDecision" ADD CONSTRAINT "ApprovalDecision_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ApprovalRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "APInvoice" ADD CONSTRAINT "APInvoice_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "APInvoice" ADD CONSTRAINT "APInvoice_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "APInvoice" ADD CONSTRAINT "APInvoice_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "APInvoice" ADD CONSTRAINT "APInvoice_postedJournalEntryId_fkey" FOREIGN KEY ("postedJournalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "APInvoice" ADD CONSTRAINT "APInvoice_reversingJournalEntryId_fkey" FOREIGN KEY ("reversingJournalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "APInvoice" ADD CONSTRAINT "APInvoice_captureId_fkey" FOREIGN KEY ("captureId") REFERENCES "ReceiptCapture"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "APInvoiceLine" ADD CONSTRAINT "APInvoiceLine_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "APInvoiceLine" ADD CONSTRAINT "APInvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "APInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "APInvoiceLine" ADD CONSTRAINT "APInvoiceLine_expenseAccountId_fkey" FOREIGN KEY ("expenseAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "APInvoiceLine" ADD CONSTRAINT "APInvoiceLine_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "APInvoiceLine" ADD CONSTRAINT "APInvoiceLine_costCenterId_fkey" FOREIGN KEY ("costCenterId") REFERENCES "CostCenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "APInvoiceLine" ADD CONSTRAINT "APInvoiceLine_taxCodeId_fkey" FOREIGN KEY ("taxCodeId") REFERENCES "TaxCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "APInvoiceAttachment" ADD CONSTRAINT "APInvoiceAttachment_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "APInvoiceAttachment" ADD CONSTRAINT "APInvoiceAttachment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "APInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptCapture" ADD CONSTRAINT "ReceiptCapture_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentBatch" ADD CONSTRAINT "PaymentBatch_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentBatch" ADD CONSTRAINT "PaymentBatch_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentBatchItem" ADD CONSTRAINT "PaymentBatchItem_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentBatchItem" ADD CONSTRAINT "PaymentBatchItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "PaymentBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentBatchItem" ADD CONSTRAINT "PaymentBatchItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "APInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentBatchItem" ADD CONSTRAINT "PaymentBatchItem_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "VendorPayment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorPayment" ADD CONSTRAINT "VendorPayment_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorPayment" ADD CONSTRAINT "VendorPayment_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorPayment" ADD CONSTRAINT "VendorPayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "APInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorPayment" ADD CONSTRAINT "VendorPayment_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "PaymentBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorPayment" ADD CONSTRAINT "VendorPayment_postedJournalEntryId_fkey" FOREIGN KEY ("postedJournalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "APException" ADD CONSTRAINT "APException_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryCategory" ADD CONSTRAINT "InventoryCategory_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryCategory" ADD CONSTRAINT "InventoryCategory_inventoryAccountId_fkey" FOREIGN KEY ("inventoryAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryCategory" ADD CONSTRAINT "InventoryCategory_cogsAccountId_fkey" FOREIGN KEY ("cogsAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryCategory" ADD CONSTRAINT "InventoryCategory_revenueAccountId_fkey" FOREIGN KEY ("revenueAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryCategory" ADD CONSTRAINT "InventoryCategory_adjustmentExpenseAccountId_fkey" FOREIGN KEY ("adjustmentExpenseAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLocation" ADD CONSTRAINT "InventoryLocation_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLocation" ADD CONSTRAINT "InventoryLocation_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "InventoryCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_preferredVendorId_fkey" FOREIGN KEY ("preferredVendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_defaultLocationId_fkey" FOREIGN KEY ("defaultLocationId") REFERENCES "InventoryLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_inventoryAccountId_fkey" FOREIGN KEY ("inventoryAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_cogsAccountId_fkey" FOREIGN KEY ("cogsAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_revenueAccountId_fkey" FOREIGN KEY ("revenueAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryTransaction" ADD CONSTRAINT "InventoryTransaction_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryTransaction" ADD CONSTRAINT "InventoryTransaction_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryTransaction" ADD CONSTRAINT "InventoryTransaction_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "InventoryLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryTransaction" ADD CONSTRAINT "InventoryTransaction_postedJournalEntryId_fkey" FOREIGN KEY ("postedJournalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryAdjustment" ADD CONSTRAINT "InventoryAdjustment_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryAdjustment" ADD CONSTRAINT "InventoryAdjustment_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryCount" ADD CONSTRAINT "InventoryCount_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryCount" ADD CONSTRAINT "InventoryCount_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "InventoryLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryCountLine" ADD CONSTRAINT "InventoryCountLine_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryCountLine" ADD CONSTRAINT "InventoryCountLine_countId_fkey" FOREIGN KEY ("countId") REFERENCES "InventoryCount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryCountLine" ADD CONSTRAINT "InventoryCountLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryReceiving" ADD CONSTRAINT "InventoryReceiving_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryReceiving" ADD CONSTRAINT "InventoryReceiving_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryReceiving" ADD CONSTRAINT "InventoryReceiving_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "InventoryLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryReceiving" ADD CONSTRAINT "InventoryReceiving_matchedApInvoiceId_fkey" FOREIGN KEY ("matchedApInvoiceId") REFERENCES "APInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryReceiving" ADD CONSTRAINT "InventoryReceiving_postedJournalEntryId_fkey" FOREIGN KEY ("postedJournalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryReceivingLine" ADD CONSTRAINT "InventoryReceivingLine_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryReceivingLine" ADD CONSTRAINT "InventoryReceivingLine_receivingId_fkey" FOREIGN KEY ("receivingId") REFERENCES "InventoryReceiving"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryReceivingLine" ADD CONSTRAINT "InventoryReceivingLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryTransfer" ADD CONSTRAINT "InventoryTransfer_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryTransfer" ADD CONSTRAINT "InventoryTransfer_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "InventoryLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryTransfer" ADD CONSTRAINT "InventoryTransfer_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "InventoryLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryTransferLine" ADD CONSTRAINT "InventoryTransferLine_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryTransferLine" ADD CONSTRAINT "InventoryTransferLine_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "InventoryTransfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryTransferLine" ADD CONSTRAINT "InventoryTransferLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventCategory" ADD CONSTRAINT "EventCategory_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventCategory" ADD CONSTRAINT "EventCategory_defaultRevenueAccountId_fkey" FOREIGN KEY ("defaultRevenueAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivateEventInquiry" ADD CONSTRAINT "PrivateEventInquiry_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivateEventBooking" ADD CONSTRAINT "PrivateEventBooking_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivateEventBooking" ADD CONSTRAINT "PrivateEventBooking_inquiryId_fkey" FOREIGN KEY ("inquiryId") REFERENCES "PrivateEventInquiry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivateEventBooking" ADD CONSTRAINT "PrivateEventBooking_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivateEventBooking" ADD CONSTRAINT "PrivateEventBooking_revenueAccountId_fkey" FOREIGN KEY ("revenueAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivateEventBooking" ADD CONSTRAINT "PrivateEventBooking_deferredRevenueAccountId_fkey" FOREIGN KEY ("deferredRevenueAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivateEventBooking" ADD CONSTRAINT "PrivateEventBooking_finalPostedJournalEntryId_fkey" FOREIGN KEY ("finalPostedJournalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivateEventDeposit" ADD CONSTRAINT "PrivateEventDeposit_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivateEventDeposit" ADD CONSTRAINT "PrivateEventDeposit_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "PrivateEventBooking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivateEventDeposit" ADD CONSTRAINT "PrivateEventDeposit_postedJournalEntryId_fkey" FOREIGN KEY ("postedJournalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivateEventMenuSelection" ADD CONSTRAINT "PrivateEventMenuSelection_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivateEventMenuSelection" ADD CONSTRAINT "PrivateEventMenuSelection_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "PrivateEventBooking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivateEventBarSelection" ADD CONSTRAINT "PrivateEventBarSelection_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivateEventBarSelection" ADD CONSTRAINT "PrivateEventBarSelection_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "PrivateEventBooking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivateEventAddOn" ADD CONSTRAINT "PrivateEventAddOn_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivateEventAddOn" ADD CONSTRAINT "PrivateEventAddOn_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "PrivateEventBooking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GolfProfessional" ADD CONSTRAINT "GolfProfessional_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GolfProfessional" ADD CONSTRAINT "GolfProfessional_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GolfProfessional" ADD CONSTRAINT "GolfProfessional_payoutVendorId_fkey" FOREIGN KEY ("payoutVendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonType" ADD CONSTRAINT "LessonType_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonType" ADD CONSTRAINT "LessonType_revenueAccountId_fkey" FOREIGN KEY ("revenueAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonType" ADD CONSTRAINT "LessonType_instructorExpenseAccountId_fkey" FOREIGN KEY ("instructorExpenseAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonBooking" ADD CONSTRAINT "LessonBooking_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonBooking" ADD CONSTRAINT "LessonBooking_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonBooking" ADD CONSTRAINT "LessonBooking_lessonTypeId_fkey" FOREIGN KEY ("lessonTypeId") REFERENCES "LessonType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonBooking" ADD CONSTRAINT "LessonBooking_instructorId_fkey" FOREIGN KEY ("instructorId") REFERENCES "GolfProfessional"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonBooking" ADD CONSTRAINT "LessonBooking_memberChargeId_fkey" FOREIGN KEY ("memberChargeId") REFERENCES "Charge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonBooking" ADD CONSTRAINT "LessonBooking_accrualJournalEntryId_fkey" FOREIGN KEY ("accrualJournalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonPayable" ADD CONSTRAINT "LessonPayable_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonPayable" ADD CONSTRAINT "LessonPayable_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "LessonBooking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonPayable" ADD CONSTRAINT "LessonPayable_instructorId_fkey" FOREIGN KEY ("instructorId") REFERENCES "GolfProfessional"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LessonPayable" ADD CONSTRAINT "LessonPayable_paidApInvoiceId_fkey" FOREIGN KEY ("paidApInvoiceId") REFERENCES "APInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeePosition" ADD CONSTRAINT "EmployeePosition_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "EmployeePosition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Timesheet" ADD CONSTRAINT "Timesheet_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Timesheet" ADD CONSTRAINT "Timesheet_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Timesheet" ADD CONSTRAINT "Timesheet_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "PayrollPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetEntry" ADD CONSTRAINT "TimesheetEntry_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetEntry" ADD CONSTRAINT "TimesheetEntry_timesheetId_fkey" FOREIGN KEY ("timesheetId") REFERENCES "Timesheet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetEntry" ADD CONSTRAINT "TimesheetEntry_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeClockEvent" ADD CONSTRAINT "TimeClockEvent_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeClockEvent" ADD CONSTRAINT "TimeClockEvent_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "PayrollPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_postedJournalEntryId_fkey" FOREIGN KEY ("postedJournalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollLine" ADD CONSTRAINT "PayrollLine_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollLine" ADD CONSTRAINT "PayrollLine_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollLine" ADD CONSTRAINT "PayrollLine_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollLine" ADD CONSTRAINT "PayrollLine_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRemittance" ADD CONSTRAINT "PayrollRemittance_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRemittance" ADD CONSTRAINT "PayrollRemittance_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "PayrollPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRemittance" ADD CONSTRAINT "PayrollRemittance_paidApInvoiceId_fkey" FOREIGN KEY ("paidApInvoiceId") REFERENCES "APInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabourBudget" ADD CONSTRAINT "LabourBudget_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabourBudget" ADD CONSTRAINT "LabourBudget_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetCategory" ADD CONSTRAINT "AssetCategory_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetCategory" ADD CONSTRAINT "AssetCategory_assetAccountId_fkey" FOREIGN KEY ("assetAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetCategory" ADD CONSTRAINT "AssetCategory_accumulatedDepreciationAccountId_fkey" FOREIGN KEY ("accumulatedDepreciationAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetCategory" ADD CONSTRAINT "AssetCategory_depreciationExpenseAccountId_fkey" FOREIGN KEY ("depreciationExpenseAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetLocation" ADD CONSTRAINT "AssetLocation_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapitalAsset" ADD CONSTRAINT "CapitalAsset_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapitalAsset" ADD CONSTRAINT "CapitalAsset_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "AssetCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapitalAsset" ADD CONSTRAINT "CapitalAsset_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "AssetLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapitalAsset" ADD CONSTRAINT "CapitalAsset_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapitalAsset" ADD CONSTRAINT "CapitalAsset_sourceApInvoiceId_fkey" FOREIGN KEY ("sourceApInvoiceId") REFERENCES "APInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapitalAsset" ADD CONSTRAINT "CapitalAsset_acquisitionJournalEntryId_fkey" FOREIGN KEY ("acquisitionJournalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetDepreciationEntry" ADD CONSTRAINT "AssetDepreciationEntry_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetDepreciationEntry" ADD CONSTRAINT "AssetDepreciationEntry_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "CapitalAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetDepreciationEntry" ADD CONSTRAINT "AssetDepreciationEntry_postedJournalEntryId_fkey" FOREIGN KEY ("postedJournalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetMaintenanceRecord" ADD CONSTRAINT "AssetMaintenanceRecord_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetMaintenanceRecord" ADD CONSTRAINT "AssetMaintenanceRecord_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "CapitalAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetMaintenanceRecord" ADD CONSTRAINT "AssetMaintenanceRecord_apInvoiceId_fkey" FOREIGN KEY ("apInvoiceId") REFERENCES "APInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetDisposal" ADD CONSTRAINT "AssetDisposal_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetDisposal" ADD CONSTRAINT "AssetDisposal_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "CapitalAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetDisposal" ADD CONSTRAINT "AssetDisposal_postedJournalEntryId_fkey" FOREIGN KEY ("postedJournalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_fiscalYearId_fkey" FOREIGN KEY ("fiscalYearId") REFERENCES "FiscalYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetLine" ADD CONSTRAINT "BudgetLine_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetLine" ADD CONSTRAINT "BudgetLine_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "Budget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetLine" ADD CONSTRAINT "BudgetLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetLine" ADD CONSTRAINT "BudgetLine_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetAssumption" ADD CONSTRAINT "BudgetAssumption_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetAssumption" ADD CONSTRAINT "BudgetAssumption_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "Budget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Forecast" ADD CONSTRAINT "Forecast_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Forecast" ADD CONSTRAINT "Forecast_fiscalYearId_fkey" FOREIGN KEY ("fiscalYearId") REFERENCES "FiscalYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Forecast" ADD CONSTRAINT "Forecast_sourceBudgetId_fkey" FOREIGN KEY ("sourceBudgetId") REFERENCES "Budget"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForecastLine" ADD CONSTRAINT "ForecastLine_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForecastLine" ADD CONSTRAINT "ForecastLine_forecastId_fkey" FOREIGN KEY ("forecastId") REFERENCES "Forecast"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForecastLine" ADD CONSTRAINT "ForecastLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForecastLine" ADD CONSTRAINT "ForecastLine_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportDefinition" ADD CONSTRAINT "ReportDefinition_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedReport" ADD CONSTRAINT "SavedReport_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedReport" ADD CONSTRAINT "SavedReport_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "ReportDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportRun" ADD CONSTRAINT "ReportRun_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportRun" ADD CONSTRAINT "ReportRun_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "ReportDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportRun" ADD CONSTRAINT "ReportRun_savedReportId_fkey" FOREIGN KEY ("savedReportId") REFERENCES "SavedReport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportExport" ADD CONSTRAINT "ReportExport_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportExport" ADD CONSTRAINT "ReportExport_reportRunId_fkey" FOREIGN KEY ("reportRunId") REFERENCES "ReportRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportingPackage" ADD CONSTRAINT "ReportingPackage_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportingPackageSection" ADD CONSTRAINT "ReportingPackageSection_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportingPackageSection" ADD CONSTRAINT "ReportingPackageSection_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "ReportingPackage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportingPackageSection" ADD CONSTRAINT "ReportingPackageSection_reportRunId_fkey" FOREIGN KEY ("reportRunId") REFERENCES "ReportRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportingPackageCommentary" ADD CONSTRAINT "ReportingPackageCommentary_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportingPackageCommentary" ADD CONSTRAINT "ReportingPackageCommentary_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "ReportingPackage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportingPackageCommentary" ADD CONSTRAINT "ReportingPackageCommentary_aiDraftId_fkey" FOREIGN KEY ("aiDraftId") REFERENCES "LLMCommentaryDraft"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageDistribution" ADD CONSTRAINT "PackageDistribution_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageDistribution" ADD CONSTRAINT "PackageDistribution_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "ReportingPackage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageApproval" ADD CONSTRAINT "PackageApproval_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageApproval" ADD CONSTRAINT "PackageApproval_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "ReportingPackage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthlyPackage" ADD CONSTRAINT "MonthlyPackage_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthlyPackage" ADD CONSTRAINT "MonthlyPackage_generatedByUserId_fkey" FOREIGN KEY ("generatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthlyPackage" ADD CONSTRAINT "MonthlyPackage_publishedByUserId_fkey" FOREIGN KEY ("publishedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthlyPackage" ADD CONSTRAINT "MonthlyPackage_sentByUserId_fkey" FOREIGN KEY ("sentByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthlyPackageRecipient" ADD CONSTRAINT "MonthlyPackageRecipient_monthlyPackageId_fkey" FOREIGN KEY ("monthlyPackageId") REFERENCES "MonthlyPackage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthlyPackageRecipient" ADD CONSTRAINT "MonthlyPackageRecipient_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoardRole" ADD CONSTRAINT "BoardRole_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoardRole" ADD CONSTRAINT "BoardRole_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditorAccessGrant" ADD CONSTRAINT "AuditorAccessGrant_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditorSession" ADD CONSTRAINT "AuditorSession_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditorSession" ADD CONSTRAINT "AuditorSession_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "AuditorAccessGrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditRequest" ADD CONSTRAINT "AuditRequest_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditRequest" ADD CONSTRAINT "AuditRequest_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "AuditorAccessGrant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditRequestItem" ADD CONSTRAINT "AuditRequestItem_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditRequestItem" ADD CONSTRAINT "AuditRequestItem_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "AuditRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditExport" ADD CONSTRAINT "AuditExport_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditExport" ADD CONSTRAINT "AuditExport_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "AuditorAccessGrant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationTemplate" ADD CONSTRAINT "NotificationTemplate_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationLog" ADD CONSTRAINT "CommunicationLog_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationCampaign" ADD CONSTRAINT "CommunicationCampaign_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "DocumentFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_retentionPolicyId_fkey" FOREIGN KEY ("retentionPolicyId") REFERENCES "DocumentRetentionPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentFolder" ADD CONSTRAINT "DocumentFolder_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentFolder" ADD CONSTRAINT "DocumentFolder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "DocumentFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentTag" ADD CONSTRAINT "DocumentTag_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentTagJoin" ADD CONSTRAINT "DocumentTagJoin_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentTagJoin" ADD CONSTRAINT "DocumentTagJoin_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "DocumentTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentAccess" ADD CONSTRAINT "DocumentAccess_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentAccess" ADD CONSTRAINT "DocumentAccess_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentRetentionPolicy" ADD CONSTRAINT "DocumentRetentionPolicy_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentAuditLog" ADD CONSTRAINT "DocumentAuditLog_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentAuditLog" ADD CONSTRAINT "DocumentAuditLog_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KPI" ADD CONSTRAINT "KPI_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KPIValue" ADD CONSTRAINT "KPIValue_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KPIValue" ADD CONSTRAINT "KPIValue_kpiId_fkey" FOREIGN KEY ("kpiId") REFERENCES "KPI"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KPIDashboard" ADD CONSTRAINT "KPIDashboard_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KPIWidget" ADD CONSTRAINT "KPIWidget_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KPIWidget" ADD CONSTRAINT "KPIWidget_dashboardId_fkey" FOREIGN KEY ("dashboardId") REFERENCES "KPIDashboard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KPIWidget" ADD CONSTRAINT "KPIWidget_kpiId_fkey" FOREIGN KEY ("kpiId") REFERENCES "KPI"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KPIThreshold" ADD CONSTRAINT "KPIThreshold_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KPIThreshold" ADD CONSTRAINT "KPIThreshold_kpiId_fkey" FOREIGN KEY ("kpiId") REFERENCES "KPI"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KPIAlert" ADD CONSTRAINT "KPIAlert_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KPIAlert" ADD CONSTRAINT "KPIAlert_kpiId_fkey" FOREIGN KEY ("kpiId") REFERENCES "KPI"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KPIAlert" ADD CONSTRAINT "KPIAlert_thresholdId_fkey" FOREIGN KEY ("thresholdId") REFERENCES "KPIThreshold"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowStep" ADD CONSTRAINT "WorkflowStep_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowStep" ADD CONSTRAINT "WorkflowStep_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowAssignment" ADD CONSTRAINT "WorkflowAssignment_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowAssignment" ADD CONSTRAINT "WorkflowAssignment_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowAssignment" ADD CONSTRAINT "WorkflowAssignment_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "WorkflowStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowApproval" ADD CONSTRAINT "WorkflowApproval_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowApproval" ADD CONSTRAINT "WorkflowApproval_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowApproval" ADD CONSTRAINT "WorkflowApproval_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "WorkflowStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowComment" ADD CONSTRAINT "WorkflowComment_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowComment" ADD CONSTRAINT "WorkflowComment_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowHistory" ADD CONSTRAINT "WorkflowHistory_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowHistory" ADD CONSTRAINT "WorkflowHistory_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubSetting" ADD CONSTRAINT "ClubSetting_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Insight" ADD CONSTRAINT "Insight_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Insight" ADD CONSTRAINT "Insight_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "InsightRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsightRule" ADD CONSTRAINT "InsightRule_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsightAlert" ADD CONSTRAINT "InsightAlert_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsightAlert" ADD CONSTRAINT "InsightAlert_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "InsightRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SearchIndexEntry" ADD CONSTRAINT "SearchIndexEntry_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationSetting" ADD CONSTRAINT "IntegrationSetting_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationCheck" ADD CONSTRAINT "IntegrationCheck_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationCheck" ADD CONSTRAINT "IntegrationCheck_settingId_fkey" FOREIGN KEY ("settingId") REFERENCES "IntegrationSetting"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentBackfillBatch" ADD CONSTRAINT "DocumentBackfillBatch_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSLocation" ADD CONSTRAINT "POSLocation_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSLocation" ADD CONSTRAINT "POSLocation_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSTerminal" ADD CONSTRAINT "POSTerminal_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSTerminal" ADD CONSTRAINT "POSTerminal_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "POSLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSTerminal" ADD CONSTRAINT "POSTerminal_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "POSIntegrationProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSSession" ADD CONSTRAINT "POSSession_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSSession" ADD CONSTRAINT "POSSession_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "POSLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSSession" ADD CONSTRAINT "POSSession_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "POSTerminal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSSale" ADD CONSTRAINT "POSSale_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSSale" ADD CONSTRAINT "POSSale_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "POSLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSSale" ADD CONSTRAINT "POSSale_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "POSTerminal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSSale" ADD CONSTRAINT "POSSale_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "POSSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSSale" ADD CONSTRAINT "POSSale_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSSale" ADD CONSTRAINT "POSSale_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSSale" ADD CONSTRAINT "POSSale_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "POSIntegrationProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSSale" ADD CONSTRAINT "POSSale_arChargeId_fkey" FOREIGN KEY ("arChargeId") REFERENCES "Charge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSSale" ADD CONSTRAINT "POSSale_postedJournalEntryId_fkey" FOREIGN KEY ("postedJournalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSSale" ADD CONSTRAINT "POSSale_refundOfSaleId_fkey" FOREIGN KEY ("refundOfSaleId") REFERENCES "POSSale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSSaleLine" ADD CONSTRAINT "POSSaleLine_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSSaleLine" ADD CONSTRAINT "POSSaleLine_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "POSSale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSSaleLine" ADD CONSTRAINT "POSSaleLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSSaleLine" ADD CONSTRAINT "POSSaleLine_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "POSMenuItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSSaleLine" ADD CONSTRAINT "POSSaleLine_revenueAccountId_fkey" FOREIGN KEY ("revenueAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSTaxLine" ADD CONSTRAINT "POSTaxLine_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSTaxLine" ADD CONSTRAINT "POSTaxLine_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "POSSale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSDiscount" ADD CONSTRAINT "POSDiscount_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSDiscount" ADD CONSTRAINT "POSDiscount_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "POSSale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSMenuCategory" ADD CONSTRAINT "POSMenuCategory_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSMenuCategory" ADD CONSTRAINT "POSMenuCategory_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "POSLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSMenuItem" ADD CONSTRAINT "POSMenuItem_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSMenuItem" ADD CONSTRAINT "POSMenuItem_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "POSMenuCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSModifierGroup" ADD CONSTRAINT "POSModifierGroup_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSModifierGroup" ADD CONSTRAINT "POSModifierGroup_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "POSMenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSModifierOption" ADD CONSTRAINT "POSModifierOption_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSModifierOption" ADD CONSTRAINT "POSModifierOption_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "POSModifierGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSCheckLineModifier" ADD CONSTRAINT "POSCheckLineModifier_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSCheckLineModifier" ADD CONSTRAINT "POSCheckLineModifier_checkLineId_fkey" FOREIGN KEY ("checkLineId") REFERENCES "POSCheckLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSPrinter" ADD CONSTRAINT "POSPrinter_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSSaleChit" ADD CONSTRAINT "POSSaleChit_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSSaleChit" ADD CONSTRAINT "POSSaleChit_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "POSSale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSSaleLineModifier" ADD CONSTRAINT "POSSaleLineModifier_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSSaleLineModifier" ADD CONSTRAINT "POSSaleLineModifier_saleLineId_fkey" FOREIGN KEY ("saleLineId") REFERENCES "POSSaleLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSPayment" ADD CONSTRAINT "POSPayment_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSPayment" ADD CONSTRAINT "POSPayment_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "POSSale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSCheck" ADD CONSTRAINT "POSCheck_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSCheck" ADD CONSTRAINT "POSCheck_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "POSLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSCheck" ADD CONSTRAINT "POSCheck_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "POSTerminal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSCheck" ADD CONSTRAINT "POSCheck_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "POSSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSCheck" ADD CONSTRAINT "POSCheck_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSCheck" ADD CONSTRAINT "POSCheck_posSaleId_fkey" FOREIGN KEY ("posSaleId") REFERENCES "POSSale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSCheck" ADD CONSTRAINT "POSCheck_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "DiningReservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSCheck" ADD CONSTRAINT "POSCheck_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "DiningTable"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSCheckLine" ADD CONSTRAINT "POSCheckLine_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSCheckLine" ADD CONSTRAINT "POSCheckLine_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "POSCheck"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSCheckLine" ADD CONSTRAINT "POSCheckLine_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "POSMenuItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSCheckLine" ADD CONSTRAINT "POSCheckLine_settlementGroupId_fkey" FOREIGN KEY ("settlementGroupId") REFERENCES "POSSettlementGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSChit" ADD CONSTRAINT "POSChit_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSChit" ADD CONSTRAINT "POSChit_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "POSCheck"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSChitLine" ADD CONSTRAINT "POSChitLine_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSChitLine" ADD CONSTRAINT "POSChitLine_chitId_fkey" FOREIGN KEY ("chitId") REFERENCES "POSChit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSChitLine" ADD CONSTRAINT "POSChitLine_checkLineId_fkey" FOREIGN KEY ("checkLineId") REFERENCES "POSCheckLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSCheckEvent" ADD CONSTRAINT "POSCheckEvent_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSCheckEvent" ADD CONSTRAINT "POSCheckEvent_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "POSCheck"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSIntegrationProvider" ADD CONSTRAINT "POSIntegrationProvider_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LLMCommentaryDraft" ADD CONSTRAINT "LLMCommentaryDraft_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundJob" ADD CONSTRAINT "BackgroundJob_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "BackgroundJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobFailure" ADD CONSTRAINT "JobFailure_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobFailure" ADD CONSTRAINT "JobFailure_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "BackgroundJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueHealth" ADD CONSTRAINT "QueueHealth_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSWebhookEvent" ADD CONSTRAINT "POSWebhookEvent_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSSyncRun" ADD CONSTRAINT "POSSyncRun_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSImportError" ADD CONSTRAINT "POSImportError_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSMapping" ADD CONSTRAINT "POSMapping_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookReplay" ADD CONSTRAINT "WebhookReplay_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Course" ADD CONSTRAINT "Course_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseHole" ADD CONSTRAINT "CourseHole_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseHole" ADD CONSTRAINT "CourseHole_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeeSheet" ADD CONSTRAINT "TeeSheet_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeeSheet" ADD CONSTRAINT "TeeSheet_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeeTime" ADD CONSTRAINT "TeeTime_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeeTime" ADD CONSTRAINT "TeeTime_teeSheetId_fkey" FOREIGN KEY ("teeSheetId") REFERENCES "TeeSheet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeeTimeBooking" ADD CONSTRAINT "TeeTimeBooking_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeeTimeBooking" ADD CONSTRAINT "TeeTimeBooking_teeTimeId_fkey" FOREIGN KEY ("teeTimeId") REFERENCES "TeeTime"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeeTimeBooking" ADD CONSTRAINT "TeeTimeBooking_primaryMemberId_fkey" FOREIGN KEY ("primaryMemberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeeTimePlayer" ADD CONSTRAINT "TeeTimePlayer_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeeTimePlayer" ADD CONSTRAINT "TeeTimePlayer_teeTimeId_fkey" FOREIGN KEY ("teeTimeId") REFERENCES "TeeTime"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeeTimePlayer" ADD CONSTRAINT "TeeTimePlayer_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "TeeTimeBooking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeeTimePlayer" ADD CONSTRAINT "TeeTimePlayer_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeeTimePlayer" ADD CONSTRAINT "TeeTimePlayer_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "TeeTimeGuest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeeTimeGuest" ADD CONSTRAINT "TeeTimeGuest_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeeTimeGuest" ADD CONSTRAINT "TeeTimeGuest_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "TeeTimeBooking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeeLottery" ADD CONSTRAINT "TeeLottery_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeeLottery" ADD CONSTRAINT "TeeLottery_teeSheetId_fkey" FOREIGN KEY ("teeSheetId") REFERENCES "TeeSheet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeeLotteryEntry" ADD CONSTRAINT "TeeLotteryEntry_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeeLotteryEntry" ADD CONSTRAINT "TeeLotteryEntry_lotteryId_fkey" FOREIGN KEY ("lotteryId") REFERENCES "TeeLottery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeeLotteryEntry" ADD CONSTRAINT "TeeLotteryEntry_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaceOfPlayRecord" ADD CONSTRAINT "PaceOfPlayRecord_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaceOfPlayRecord" ADD CONSTRAINT "PaceOfPlayRecord_teeTimeId_fkey" FOREIGN KEY ("teeTimeId") REFERENCES "TeeTime"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartAssignment" ADD CONSTRAINT "CartAssignment_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartAssignment" ADD CONSTRAINT "CartAssignment_teeTimeId_fkey" FOREIGN KEY ("teeTimeId") REFERENCES "TeeTime"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HardwareDevice" ADD CONSTRAINT "HardwareDevice_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceEvent" ADD CONSTRAINT "DeviceEvent_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceEvent" ADD CONSTRAINT "DeviceEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "HardwareDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceStatus" ADD CONSTRAINT "DeviceStatus_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceStatus" ADD CONSTRAINT "DeviceStatus_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "HardwareDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceAssignment" ADD CONSTRAINT "DeviceAssignment_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceAssignment" ADD CONSTRAINT "DeviceAssignment_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "HardwareDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeatureFlag" ADD CONSTRAINT "FeatureFlag_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RateLimitBucket" ADD CONSTRAINT "RateLimitBucket_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObservabilityEvent" ADD CONSTRAINT "ObservabilityEvent_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetricCounter" ADD CONSTRAINT "MetricCounter_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthAttempt" ADD CONSTRAINT "AuthAttempt_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountLock" ADD CONSTRAINT "AccountLock_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuspiciousActivityEvent" ADD CONSTRAINT "SuspiciousActivityEvent_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebPushSubscription" ADD CONSTRAINT "WebPushSubscription_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebPushSubscription" ADD CONSTRAINT "WebPushSubscription_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tournament" ADD CONSTRAINT "Tournament_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tournament" ADD CONSTRAINT "Tournament_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tournament" ADD CONSTRAINT "Tournament_revenueAccountId_fkey" FOREIGN KEY ("revenueAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentDivision" ADD CONSTRAINT "TournamentDivision_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentDivision" ADD CONSTRAINT "TournamentDivision_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentRegistration" ADD CONSTRAINT "TournamentRegistration_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentRegistration" ADD CONSTRAINT "TournamentRegistration_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentRegistration" ADD CONSTRAINT "TournamentRegistration_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "TournamentDivision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentRegistration" ADD CONSTRAINT "TournamentRegistration_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentRegistration" ADD CONSTRAINT "TournamentRegistration_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "TournamentTeam"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentTeam" ADD CONSTRAINT "TournamentTeam_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentTeam" ADD CONSTRAINT "TournamentTeam_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentRound" ADD CONSTRAINT "TournamentRound_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentRound" ADD CONSTRAINT "TournamentRound_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentMatch" ADD CONSTRAINT "TournamentMatch_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentMatch" ADD CONSTRAINT "TournamentMatch_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentMatch" ADD CONSTRAINT "TournamentMatch_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "TournamentRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentMatch" ADD CONSTRAINT "TournamentMatch_playerARegistrationId_fkey" FOREIGN KEY ("playerARegistrationId") REFERENCES "TournamentRegistration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentMatch" ADD CONSTRAINT "TournamentMatch_playerBRegistrationId_fkey" FOREIGN KEY ("playerBRegistrationId") REFERENCES "TournamentRegistration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentScore" ADD CONSTRAINT "TournamentScore_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentScore" ADD CONSTRAINT "TournamentScore_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentScore" ADD CONSTRAINT "TournamentScore_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "TournamentRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentScore" ADD CONSTRAINT "TournamentScore_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "TournamentRegistration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentScore" ADD CONSTRAINT "TournamentScore_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentLeaderboard" ADD CONSTRAINT "TournamentLeaderboard_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentLeaderboard" ADD CONSTRAINT "TournamentLeaderboard_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentPayoutPrize" ADD CONSTRAINT "TournamentPayoutPrize_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentPayoutPrize" ADD CONSTRAINT "TournamentPayoutPrize_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentCommunication" ADD CONSTRAINT "TournamentCommunication_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentCommunication" ADD CONSTRAINT "TournamentCommunication_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKeyPermission" ADD CONSTRAINT "ApiKeyPermission_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKeyPermission" ADD CONSTRAINT "ApiKeyPermission_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiRequestLog" ADD CONSTRAINT "ApiRequestLog_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiRequestLog" ADD CONSTRAINT "ApiRequestLog_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookSubscription" ADD CONSTRAINT "WebhookSubscription_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "WebhookSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PilotReadinessItem" ADD CONSTRAINT "PilotReadinessItem_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushDeliveryAttempt" ADD CONSTRAINT "PushDeliveryAttempt_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushDeliveryAttempt" ADD CONSTRAINT "PushDeliveryAttempt_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "PushCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushCampaign" ADD CONSTRAINT "PushCampaign_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentPairing" ADD CONSTRAINT "TournamentPairing_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubSubscription" ADD CONSTRAINT "ClubSubscription_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubSubscription" ADD CONSTRAINT "ClubSubscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SubscriptionPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageMetric" ADD CONSTRAINT "UsageMetric_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingCycle" ADD CONSTRAINT "BillingCycle_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookSecretVersion" ADD CONSTRAINT "WebhookSecretVersion_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookSecretVersion" ADD CONSTRAINT "WebhookSecretVersion_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "WebhookSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookSecretRotation" ADD CONSTRAINT "WebhookSecretRotation_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSMappingHistory" ADD CONSTRAINT "POSMappingHistory_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentScoreDraft" ADD CONSTRAINT "TournamentScoreDraft_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentScoreConflict" ADD CONSTRAINT "TournamentScoreConflict_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentScoreConflict" ADD CONSTRAINT "TournamentScoreConflict_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "TournamentScoreDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentScoreCorrection" ADD CONSTRAINT "TournamentScoreCorrection_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingCustomer" ADD CONSTRAINT "BillingCustomer_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingSubscription" ADD CONSTRAINT "BillingSubscription_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingSubscription" ADD CONSTRAINT "BillingSubscription_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "BillingCustomer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingInvoice" ADD CONSTRAINT "BillingInvoice_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingInvoice" ADD CONSTRAINT "BillingInvoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "BillingCustomer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingPaymentAttempt" ADD CONSTRAINT "BillingPaymentAttempt_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingPaymentAttempt" ADD CONSTRAINT "BillingPaymentAttempt_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "BillingCustomer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingPaymentAttempt" ADD CONSTRAINT "BillingPaymentAttempt_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "BillingInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingWebhookEvent" ADD CONSTRAINT "BillingWebhookEvent_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MfaFactor" ADD CONSTRAINT "MfaFactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryCode" ADD CONSTRAINT "RecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrustedDevice" ADD CONSTRAINT "TrustedDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SsoProvider" ADD CONSTRAINT "SsoProvider_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SsoLoginAttempt" ADD CONSTRAINT "SsoLoginAttempt_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SsoLoginAttempt" ADD CONSTRAINT "SsoLoginAttempt_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "SsoProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecretAccessLog" ADD CONSTRAINT "SecretAccessLog_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeyRotationEvent" ADD CONSTRAINT "KeyRotationEvent_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EncryptedSecretMetadata" ADD CONSTRAINT "EncryptedSecretMetadata_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstalledApp" ADD CONSTRAINT "InstalledApp_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstalledApp" ADD CONSTRAINT "InstalledApp_appId_fkey" FOREIGN KEY ("appId") REFERENCES "MarketplaceApp"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppPermission" ADD CONSTRAINT "AppPermission_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppPermission" ADD CONSTRAINT "AppPermission_installedAppId_fkey" FOREIGN KEY ("installedAppId") REFERENCES "InstalledApp"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthGrant" ADD CONSTRAINT "OAuthGrant_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthGrant" ADD CONSTRAINT "OAuthGrant_appId_fkey" FOREIGN KEY ("appId") REFERENCES "MarketplaceApp"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthGrant" ADD CONSTRAINT "OAuthGrant_installedAppId_fkey" FOREIGN KEY ("installedAppId") REFERENCES "InstalledApp"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppWebhookSubscription" ADD CONSTRAINT "AppWebhookSubscription_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppWebhookSubscription" ADD CONSTRAINT "AppWebhookSubscription_installedAppId_fkey" FOREIGN KEY ("installedAppId") REFERENCES "InstalledApp"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessReview" ADD CONSTRAINT "AccessReview_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessReviewItem" ADD CONSTRAINT "AccessReviewItem_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessReviewItem" ADD CONSTRAINT "AccessReviewItem_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "AccessReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceEvidence" ADD CONSTRAINT "ComplianceEvidence_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyAcknowledgement" ADD CONSTRAINT "PolicyAcknowledgement_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CircuitBreakerState" ADD CONSTRAINT "CircuitBreakerState_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PilotOnboardingProject" ADD CONSTRAINT "PilotOnboardingProject_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PilotOnboardingStep" ADD CONSTRAINT "PilotOnboardingStep_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PilotOnboardingStep" ADD CONSTRAINT "PilotOnboardingStep_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PilotOnboardingProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PilotOnboardingTask" ADD CONSTRAINT "PilotOnboardingTask_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PilotOnboardingTask" ADD CONSTRAINT "PilotOnboardingTask_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PilotOnboardingProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PilotOnboardingNote" ADD CONSTRAINT "PilotOnboardingNote_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PilotOnboardingNote" ADD CONSTRAINT "PilotOnboardingNote_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PilotOnboardingProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PilotOnboardingBlocker" ADD CONSTRAINT "PilotOnboardingBlocker_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PilotOnboardingBlocker" ADD CONSTRAINT "PilotOnboardingBlocker_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PilotOnboardingProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PilotGoLiveSignoff" ADD CONSTRAINT "PilotGoLiveSignoff_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PilotGoLiveSignoff" ADD CONSTRAINT "PilotGoLiveSignoff_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PilotOnboardingProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportError" ADD CONSTRAINT "ImportError_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportError" ADD CONSTRAINT "ImportError_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpeningBalanceSet" ADD CONSTRAINT "OpeningBalanceSet_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberPortalInvite" ADD CONSTRAINT "MemberPortalInvite_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubTrainingMode" ADD CONSTRAINT "ClubTrainingMode_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingScenario" ADD CONSTRAINT "TrainingScenario_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAccessGrant" ADD CONSTRAINT "SupportAccessGrant_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "SupportAccessGrant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportActionLog" ADD CONSTRAINT "SupportActionLog_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportActionLog" ADD CONSTRAINT "SupportActionLog_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "SupportSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentTimelineEvent" ADD CONSTRAINT "IncidentTimelineEvent_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentTimelineEvent" ADD CONSTRAINT "IncidentTimelineEvent_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubDomain" ADD CONSTRAINT "ClubDomain_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportTemplate" ADD CONSTRAINT "ImportTemplate_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailDeliveryEvent" ADD CONSTRAINT "EmailDeliveryEvent_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailSuppression" ADD CONSTRAINT "EmailSuppression_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PilotRetrospective" ADD CONSTRAINT "PilotRetrospective_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetrospectiveItem" ADD CONSTRAINT "RetrospectiveItem_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetrospectiveItem" ADD CONSTRAINT "RetrospectiveItem_retrospectiveId_fkey" FOREIGN KEY ("retrospectiveId") REFERENCES "PilotRetrospective"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetrospectiveAction" ADD CONSTRAINT "RetrospectiveAction_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetrospectiveAction" ADD CONSTRAINT "RetrospectiveAction_retrospectiveId_fkey" FOREIGN KEY ("retrospectiveId") REFERENCES "PilotRetrospective"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PilotMetricSnapshot" ADD CONSTRAINT "PilotMetricSnapshot_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospitalitySurveyInvitation" ADD CONSTRAINT "HospitalitySurveyInvitation_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospitalitySurveyInvitation" ADD CONSTRAINT "HospitalitySurveyInvitation_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospitalitySurveyInvitation" ADD CONSTRAINT "HospitalitySurveyInvitation_posCheckId_fkey" FOREIGN KEY ("posCheckId") REFERENCES "POSCheck"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospitalitySurveyInvitation" ADD CONSTRAINT "HospitalitySurveyInvitation_posSaleId_fkey" FOREIGN KEY ("posSaleId") REFERENCES "POSSale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospitalitySurveyInvitation" ADD CONSTRAINT "HospitalitySurveyInvitation_posSettlementGroupId_fkey" FOREIGN KEY ("posSettlementGroupId") REFERENCES "POSSettlementGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospitalitySurveyResponse" ADD CONSTRAINT "HospitalitySurveyResponse_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospitalitySurveyResponse" ADD CONSTRAINT "HospitalitySurveyResponse_invitationId_fkey" FOREIGN KEY ("invitationId") REFERENCES "HospitalitySurveyInvitation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospitalitySurveyResponse" ADD CONSTRAINT "HospitalitySurveyResponse_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospitalitySurveyResponse" ADD CONSTRAINT "HospitalitySurveyResponse_posCheckId_fkey" FOREIGN KEY ("posCheckId") REFERENCES "POSCheck"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospitalitySurveyResponse" ADD CONSTRAINT "HospitalitySurveyResponse_posSaleId_fkey" FOREIGN KEY ("posSaleId") REFERENCES "POSSale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospitalitySurveyResponse" ADD CONSTRAINT "HospitalitySurveyResponse_posSettlementGroupId_fkey" FOREIGN KEY ("posSettlementGroupId") REFERENCES "POSSettlementGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentNotificationRule" ADD CONSTRAINT "DepartmentNotificationRule_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiningArea" ADD CONSTRAINT "DiningArea_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiningTable" ADD CONSTRAINT "DiningTable_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiningTable" ADD CONSTRAINT "DiningTable_diningAreaId_fkey" FOREIGN KEY ("diningAreaId") REFERENCES "DiningArea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiningFloorPlan" ADD CONSTRAINT "DiningFloorPlan_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiningFloorPlan" ADD CONSTRAINT "DiningFloorPlan_diningAreaId_fkey" FOREIGN KEY ("diningAreaId") REFERENCES "DiningArea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiningFloorPlanTable" ADD CONSTRAINT "DiningFloorPlanTable_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiningFloorPlanTable" ADD CONSTRAINT "DiningFloorPlanTable_floorPlanId_fkey" FOREIGN KEY ("floorPlanId") REFERENCES "DiningFloorPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiningFloorPlanTable" ADD CONSTRAINT "DiningFloorPlanTable_sourceDiningTableId_fkey" FOREIGN KEY ("sourceDiningTableId") REFERENCES "DiningTable"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiningReservation" ADD CONSTRAINT "DiningReservation_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiningReservation" ADD CONSTRAINT "DiningReservation_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiningReservation" ADD CONSTRAINT "DiningReservation_diningAreaId_fkey" FOREIGN KEY ("diningAreaId") REFERENCES "DiningArea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiningReservation" ADD CONSTRAINT "DiningReservation_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "DiningTable"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiningReservationCheckLink" ADD CONSTRAINT "DiningReservationCheckLink_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiningReservationCheckLink" ADD CONSTRAINT "DiningReservationCheckLink_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "DiningReservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiningReservationCheckLink" ADD CONSTRAINT "DiningReservationCheckLink_posCheckId_fkey" FOREIGN KEY ("posCheckId") REFERENCES "POSCheck"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiningReservationCheckLink" ADD CONSTRAINT "DiningReservationCheckLink_posSaleId_fkey" FOREIGN KEY ("posSaleId") REFERENCES "POSSale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservationSettings" ADD CONSTRAINT "ReservationSettings_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSSettlementGroup" ADD CONSTRAINT "POSSettlementGroup_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSSettlementGroup" ADD CONSTRAINT "POSSettlementGroup_posCheckId_fkey" FOREIGN KEY ("posCheckId") REFERENCES "POSCheck"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSSettlementGroup" ADD CONSTRAINT "POSSettlementGroup_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSSettlementGroup" ADD CONSTRAINT "POSSettlementGroup_posSaleId_fkey" FOREIGN KEY ("posSaleId") REFERENCES "POSSale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSCheckSeat" ADD CONSTRAINT "POSCheckSeat_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSCheckSeat" ADD CONSTRAINT "POSCheckSeat_posCheckId_fkey" FOREIGN KEY ("posCheckId") REFERENCES "POSCheck"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSCheckSeat" ADD CONSTRAINT "POSCheckSeat_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSQRPayment" ADD CONSTRAINT "POSQRPayment_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSQRPayment" ADD CONSTRAINT "POSQRPayment_posCheckId_fkey" FOREIGN KEY ("posCheckId") REFERENCES "POSCheck"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSQRPayment" ADD CONSTRAINT "POSQRPayment_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSQRPayment" ADD CONSTRAINT "POSQRPayment_posSaleId_fkey" FOREIGN KEY ("posSaleId") REFERENCES "POSSale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportingLedgerSnapshot" ADD CONSTRAINT "ReportingLedgerSnapshot_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ReportingLedgerBatch"("batchId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkIntakeItem" ADD CONSTRAINT "WorkIntakeItem_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkIntakeItem" ADD CONSTRAINT "WorkIntakeItem_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkIntakeItem" ADD CONSTRAINT "WorkIntakeItem_resolvedByUserId_fkey" FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkIntakeItem" ADD CONSTRAINT "WorkIntakeItem_classificationOverriddenByUserId_fkey" FOREIGN KEY ("classificationOverriddenByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkIntakeActivity" ADD CONSTRAINT "WorkIntakeActivity_workIntakeItemId_fkey" FOREIGN KEY ("workIntakeItemId") REFERENCES "WorkIntakeItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkIntakeActivity" ADD CONSTRAINT "WorkIntakeActivity_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailWorkIntakeOrigin" ADD CONSTRAINT "EmailWorkIntakeOrigin_workIntakeItemId_fkey" FOREIGN KEY ("workIntakeItemId") REFERENCES "WorkIntakeItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailWorkIntakeOrigin" ADD CONSTRAINT "EmailWorkIntakeOrigin_emailMessageId_fkey" FOREIGN KEY ("emailMessageId") REFERENCES "EmailMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailboxConnection" ADD CONSTRAINT "MailboxConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailboxConnection" ADD CONSTRAINT "MailboxConnection_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailboxConnection" ADD CONSTRAINT "MailboxConnection_disconnectedByUserId_fkey" FOREIGN KEY ("disconnectedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailboxAccess" ADD CONSTRAINT "MailboxAccess_mailboxConnectionId_fkey" FOREIGN KEY ("mailboxConnectionId") REFERENCES "MailboxConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailboxAccess" ADD CONSTRAINT "MailboxAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailboxAccess" ADD CONSTRAINT "MailboxAccess_grantedByUserId_fkey" FOREIGN KEY ("grantedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailboxAccess" ADD CONSTRAINT "MailboxAccess_revokedByUserId_fkey" FOREIGN KEY ("revokedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GraphSubscription" ADD CONSTRAINT "GraphSubscription_mailboxConnectionId_fkey" FOREIGN KEY ("mailboxConnectionId") REFERENCES "MailboxConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_mailboxConnectionId_fkey" FOREIGN KEY ("mailboxConnectionId") REFERENCES "MailboxConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailboxSyncRun" ADD CONSTRAINT "MailboxSyncRun_mailboxConnectionId_fkey" FOREIGN KEY ("mailboxConnectionId") REFERENCES "MailboxConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailboxOAuthTransaction" ADD CONSTRAINT "MailboxOAuthTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailboxOAuthTransaction" ADD CONSTRAINT "MailboxOAuthTransaction_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailAttachment" ADD CONSTRAINT "EmailAttachment_emailMessageId_fkey" FOREIGN KEY ("emailMessageId") REFERENCES "EmailMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

