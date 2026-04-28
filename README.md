# Med Billing Backend

NestJS + MongoDB API for the MedBilling Pro operations workspace. This backend
is the data and API source of truth for `med-frontend`.

Read the workspace guide first:

- `../AGENTS.md`

## Quick Start

Prerequisites:

- Node.js and npm
- Docker, if using the included MongoDB compose file

Setup:

```bash
npm install
cp .env.example .env.local
docker-compose up -d
npm run start:dev
```

Default URLs:

- API base: `http://localhost:3001/api`
- Swagger docs: `http://localhost:3001/docs`
- Health: `http://localhost:3001/api/health`
- MongoDB: `mongodb://localhost:27017/med_billing_pro`

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run start:dev` | Start Nest in watch mode. |
| `npm run start` | Start Nest once. |
| `npm run build` | Compile TypeScript to `dist/`. |
| `npm run start:prod` | Run `dist/main.js`. |

There is no committed backend test or lint script in this checkout. Use
`npm run build` as the minimum verification gate and smoke-test changed
endpoints locally.

## Environment

Configuration loads from `.env.local` first, then `.env`.

Core variables:

| Variable | Purpose |
| --- | --- |
| `PORT` | API port, default `3001`. |
| `MONGODB_URI` | Mongo connection string. |
| `APP_PUBLIC_URL` | Public base URL used for generated file URLs. |
| `JWT_SECRET` | JWT secret. |
| `FILE_SIGNING_SECRET` | Secret for signed local file URLs. Falls back to `JWT_SECRET`. |
| `OPENAI_API_KEY` | Optional LLM extraction key. Do not enable for PHI/EOB data unless the deployment has an approved compliance path. |
| `OPENAI_MODEL` | Chat completions model, default `gpt-4o-mini`, used only when `OPENAI_API_KEY` is configured. |
| `AWS_REGION` | AWS region for S3/Textract, default `us-west-1`. |
| `AWS_S3_BUCKET` | Required for S3 upload URLs and S3/Textract extraction. |
| `AWS_S3_KMS_KEY_ID` | KMS key for sensitive S3 uploads. Required for production EOB storage. |
| `TEXTRACT_MAX_WAIT_SECONDS` | Max Textract polling time, default `90`. |
| `MINERU_SERVICE_URL` | Local PDF extraction service URL, default `http://127.0.0.1:18080`. |
| `PHI_ENCRYPTION_KEY_B64` | Template variable for PHI encryption. |
| `PHI_INDEX_KEY_B64` | Template variable for PHI indexed lookup. |
| `PHI_ENCRYPTION_KEY_ID` | Template key id. |

Never commit `.env`, `.env.local`, secrets, uploaded files, or real PHI.

## Project Map

| Path | Purpose |
| --- | --- |
| `src/main.ts` | Bootstraps Nest, enables CORS, sets `/api`, validation, exception filter, Swagger. |
| `src/app.module.ts` | Loads config, connects MongoDB, wires feature modules. |
| `src/common/constants/entities.constant.ts` | Canonical resource entity list and collection mapping. |
| `src/common/dto/resource-query.dto.ts` | Query DTO for generic entity listing. |
| `src/common/utils/entity.utils.ts` | Entity validation, filter parsing, sort, id generation, serialization. |
| `src/common/filters/http-exception.filter.ts` | Global HTTP error response shape. |
| `src/resources/*` | Generic resource CRUD controller/service. |
| `src/files/*` | Local and S3 file handling, public/signed URL serving. |
| `src/integrations/*` | Upload aliases, signed URLs, OpenAI extraction, Textract, MinerU, EOB storage. |
| `src/health/*` | API and MongoDB health check. |
| `src/seed/seed.service.ts` | Ensures upload directories and seeds default claim statuses. |
| `uploads/` | Runtime local file storage. Do not commit uploaded files. |
| `docker-compose.yml` | Local MongoDB service. |

## Runtime Architecture

The backend uses one generic resource model for most business data. Documents
are stored in named Mongo collections with a flexible schema:

- `strict: false`
- `id`, `created_date`, and `updated_date` are managed by the service when
  missing.
- Mongo `_id` and `__v` are removed from API responses.

The frontend relies on this flexible model. Until formal schemas are added, the
field dictionary below is the practical application contract.

## API Route Dictionary

All routes are mounted under `/api`.

### Health

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Returns API status, Mongo connection state, and timestamp. |

### Generic Entities

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/entities/:entity` | List resources. Supports `sort`, `limit`, `offset`, and `filter`. |
| `GET` | `/entities/:entity/:id` | Fetch one resource by application `id`. |
| `POST` | `/entities/:entity` | Create one resource. |
| `POST` | `/entities/:entity/bulk` | Create many resources. Body may be an array or `{ items: [] }`. |
| `PATCH` | `/entities/:entity/:id` | Update one resource by application `id`. |
| `DELETE` | `/entities/:entity/:id` | Delete one resource by application `id`. |

Query behavior:

- `sort=field` sorts ascending.
- `sort=-field` sorts descending.
- Default sort is `created_date` descending.
- `limit` and `offset` are non-negative integers.
- `filter` is a JSON object encoded as a string.
- Array filter values are converted to Mongo `$in`.

Example:

```bash
curl 'http://localhost:3001/api/entities/Claim?sort=-created_date&limit=50&filter=%7B%22status%22%3A%22PAID%22%7D'
```

### Files

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/files/upload` | Multipart upload to local public storage. |
| `POST` | `/files/upload-private` | Multipart upload to local private storage. |
| `GET` | `/files/public/:fileName` | Serve a public local file. |
| `HEAD` | `/files/public/:fileName` | Return public local file metadata. |
| `GET` | `/files/signed/:token` | Serve a signed local private file. |
| `HEAD` | `/files/signed/:token` | Return signed local file metadata. |

Public upload response fields:

- `file_uri`
- `file_url`
- `original_name`
- `mime_type`
- `size`

Private upload response omits `file_url`; callers request signed URLs when
needed.

### Integrations

Controller path: `/integrations/core`.

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/upload-file` | Alias for public local upload. |
| `POST` | `/upload-private-file` | Alias for private local upload. |
| `POST` | `/create-file-signed-url` | Create a signed URL for local or S3 file references. |
| `POST` | `/create-s3-upload-url` | Create a presigned S3 upload URL and opaque `upload_ref`. |
| `POST` | `/create-eob-batch-from-upload` | Create an EOB batch from an opaque upload reference. |
| `POST` | `/extract-data-from-eob-batch` | Extract data from the backend-owned file attached to an EOB batch. |
| `POST` | `/extract-data-from-uploaded-file` | Extract structured data from a file reference and schema. |
| `POST` | `/extract-and-store-eob` | Extract EOB data and create `EOBBatch`/`EOBLine` records. |
| `POST` | `/invoke-llm` | General LLM text or structured JSON invocation. |

Extraction behavior:

- S3 references use Textract. Textract extracts OCR lines/tables; local parsers
  map that output into app entities such as `EOBLine`.
- For EOB PDFs, Textract is called with table/form analysis plus explicit
  queries for check amount, EFT/payment amount, check number, payment date, and
  payer. Batch `total_amount` should come from the check/EFT total when present,
  while `total_provider_paid` remains the sum of parsed service lines.
- Local PDF references use the MinerU service at `MINERU_SERVICE_URL`.
- Local non-PDF files are read as text.
- OpenAI is optional and should not be required for secure EOB upload. When it is
  not configured, local parsers handle known `transactions`, `eob_lines`, and
  `claims` schema shapes. New payer layouts require new local parser support.

## Resource Entity Dictionary

Canonical entity names are defined in
`src/common/constants/entities.constant.ts`.

| Entity | Collection | Frontend export | Meaning |
| --- | --- | --- | --- |
| `Claim` | `claims` | `claimsApi` | One billed encounter/date of service. |
| `ClaimStatus` | `claim_statuses` | `claimStatusesApi` | User-editable claim status definitions. |
| `ClaimChangeHistory` | `claim_change_history` | `claimChangeHistoryApi` | Claim audit log entries. |
| `Patient` | `patients` | `patientsApi` | Patient directory/profile records. |
| `Provider` | `providers` | `providersApi` | Provider directory records. |
| `Upload` | `uploads` | `uploadsApi` | Bulk import history. |
| `EOBBatch` | `eob_batches` | `eobBatchesApi` | Uploaded/manual check or EOB batch. |
| `EOBLine` | `eob_lines` | `eobLinesApi` | Service/payment line inside an EOB batch. |
| `EOBPostingSession` | `eob_posting_sessions` | `eobPostingSessionsApi` | Draft state for EOB queue posting. |
| `InsuranceGroup` | `insurance_groups` | `insuranceGroupsApi` | Named payer groups for filtering. |
| `TrackedCPT` | `tracked_cpts` | `trackedCptsApi` | CPT directory/reminder entries. |
| `CAPPCheck` | `capp_checks` | `cappChecksApi` | CAPP/OPTUM bulk payment records. |
| `CAPPAlert` | `capp_alerts` | `cappAlertsApi` | Alerts for newly eligible CAPP/OPTUM claims. |
| `Invoice` | `invoices` | `invoicesApi` | Invoice records and generated invoice files. |

## Field Dictionary

### Common Resource Fields

Every resource may include:

- `id`: application id. If absent on create, backend creates
  `<entity>-<timestamp>-<random>`.
- `created_date`: ISO timestamp. Preserved on create if supplied.
- `updated_date`: ISO timestamp. Set on create and update.

### `Claim`

Important fields:

- `patient_name`
- `patient_dob`
- `provider`
- `date_of_service`
- `insurance_company`
- `bill_number`
- `eob_number`
- `secondary_check_number`
- `status`
- `cpt_codes`
- `total_billed`
- `total_paid`
- `copay`
- `secondary_payment`
- `capp_payment`
- `patient_payment`
- `patient_balance`
- `manual_days_in_status`
- `status_changed_date`
- `comments`

CPT object fields:

- `code`
- `description`
- `amount_billed`
- `amount_paid`
- `secondary_payment`

### `ClaimStatus`

Fields:

- `name`
- `description`
- `color`
- `is_active`
- `sort_order`

Default statuses are seeded from `DEFAULT_CLAIM_STATUSES` when
`claim_statuses` is empty.

### `ClaimChangeHistory`

Fields:

- `claim_id`
- `patient_name`
- `change_type`
- `field_changed`
- `old_value`
- `new_value`
- `change_description`
- `changed_by`
- `change_date`

### `Patient`

Fields:

- `name`
- `date_of_birth`
- `preventative_cpts`

Preventative CPT objects may include:

- `code`
- `description`
- `last_billed_date`
- `next_reminder_date`
- `notes`

### `Provider`

Fields:

- `provider_name`
- `hire_date`
- `specialty`
- `npi`
- `email`
- `phone`
- `notes`
- `is_active`
- `termination_date`

### `Upload`

Fields:

- `upload_date`
- `file_name`
- `total_rows`
- `success_count`
- `skip_count`
- `cancellation_count`
- `total_revenue`
- `claim_ids`

### `EOBBatch`

Fields:

- `eob_id`
- `file_name`
- `payer_name`
- `check_number`
- `check_date`
- `total_lines`
- `line_count`
- `total_amount`
- `total_billed_amt`
- `total_allowed_amt`
- `total_provider_paid`
- `total_patient_resp`
- `auto_posted`
- `needs_review`
- `no_match`
- `status`: commonly `READY`, `POSTED`, `DEPOSITED`, `FAILED`.
- `pdf_file_uri`
- `source_file_uri`
- `invoice_id`
- `check_type`: commonly `FEE_FOR_SERVICE`, `CAPP`, `INCENTIVE`,
  `COMMISSION_CREDIT`.
- `capp_entry_loaded`
- `capp_check_id`
- `is_denials_check`
- `notes`

### `EOBLine`

Fields:

- `eob_id`
- `seq_no`
- `payer_name`
- `check_number`
- `check_date`
- `trace_no`
- `icn`
- `patient_name`
- `member_id`
- `dob`
- `rendering_npi`
- `dos_from`
- `dos_to`
- `cpt`
- `units`
- `billed_amt`
- `allowed_amt`
- `carc_group`
- `carc_code`
- `remark_code`
- `patient_resp`
- `provider_paid`
- `matched_claim_id`
- `match_score`
- `status_bucket`: commonly `AUTO_POST`, `NEEDS_REVIEW`, `NO_MATCH`,
  `POSTED`, `REJECTED`.
- `notes`

### `EOBPostingSession`

Fields:

- `check_number`
- `current_group_index`
- `payment_data`
- `groups_data`
- `last_modified`

### `InsuranceGroup`

Fields:

- `group_name`
- `insurances`
- `is_active`

### `TrackedCPT`

Fields:

- `code`
- `description`
- `reminder_interval_months`
- `last_billed_date`
- `next_reminder_date`
- `notes`
- `is_active`

### `CAPPCheck`

Fields:

- `check_amount`
- `source`
- `check_date`
- `check_month`
- `expected_total_claims`
- `claims_count`
- `amount_per_claim`
- `total_applied`
- `unallocated_balance`
- `claim_ids`
- `notes`

### `CAPPAlert`

Fields:

- `claim_id`
- `patient_name`
- `capp_check_id`
- `check_month`
- `payment_type`
- `new_status`
- `alert_date`
- `is_resolved`
- `resolved_date`

### `Invoice`

Fields:

- `invoice_number`
- `status`: `OPEN` or `CLOSED`.
- `total_amount`
- `check_count`
- `created_date`
- `closed_date`
- `invoice_file_uri`

## File Storage Dictionary

Local storage root is `uploads/`.

| Visibility | URI shape | URL behavior |
| --- | --- | --- |
| Public | `public/<stored-name>` | Can be served through `/api/files/public/:fileName`. |
| Private | `private/<stored-name>` | Must be accessed through `/api/files/signed/:token`. |
| S3 | `s3://<bucket>/<key>` | Signed directly with S3 presigned URLs. |

File names are sanitized. Local paths are normalized and checked to prevent
path traversal outside `uploads/`.

Supported S3 presigned upload MIME types:

- `application/pdf`
- `image/jpeg`
- `image/png`
- `image/tiff`
- `text/plain`
- `text/csv`

Sensitive EOB files must stay on the S3/KMS path. Do not route EOB PDFs through
the local/private upload fallback. If a browser PUT to the presigned URL returns
`AccessDenied` or `Forbidden`, fix AWS permissions instead of changing storage.
The frontend should only receive the presigned PUT URL and an opaque
`upload_ref`; backend code owns the `s3://` object reference and resolves it when
creating EOB batches, signed view URLs, or Textract jobs.

The backend signing identity needs S3 write/read permission on `AWS_S3_BUCKET`
and KMS permission on the configured `AWS_S3_KMS_KEY_ID`:

- `kms:GenerateDataKey` for encrypted `PutObject`.
- `kms:Decrypt` for later reads, signed downloads, and Textract processing.
- Key policy access in the account that owns the KMS key if the signing IAM
  principal is in another account.

The bucket CORS policy must allow browser `PUT` and the signed headers returned
by `create-s3-upload-url`, including `content-type`,
`x-amz-server-side-encryption`, `x-amz-server-side-encryption-aws-kms-key-id`,
and AWS checksum headers.

## Integration Flow Dictionary

### Generic LLM Invocation

`POST /api/integrations/core/invoke-llm`

Body:

- `prompt`
- `file_urls`
- `response_json_schema`

If `response_json_schema` is supplied, the backend requests JSON and parses the
response. Without a schema, it returns text.

### File Extraction

`POST /api/integrations/core/extract-data-from-uploaded-file`

Body:

- `file_url`
- `json_schema`

Response:

- `{ status: "success", output }`
- `{ status: "error", details }`

Schema shape controls extraction hints:

- A schema containing `transactions` triggers transaction journal prompts and
  fallback parsing.
- A schema containing `eob_lines` triggers EOB prompts and fallback parsing.
- A schema containing `claims` triggers claim report prompts and fallback
  parsing.

### Extract And Store EOB

`POST /api/integrations/core/extract-and-store-eob`

Body:

- `file_uri`
- `file_name`
- `json_schema`

Creates an `EOBBatch`, bulk creates `EOBLine` records, and returns both plus the
raw extraction output.

## Adding Or Changing Entities

When adding a new resource entity:

1. Add the entity name to `RESOURCE_ENTITIES`.
2. Add the collection name to `ENTITY_COLLECTIONS`.
3. Add seed data if the entity needs defaults.
4. Export a matching API client in `med-frontend/src/api/backendClient.js`.
5. Document the entity and fields in both README files.
6. Run `npm run build`.
7. Smoke-test the frontend flow that consumes the entity.

When changing a field used by the frontend, update the frontend field
dictionary and every create/update/filter usage. Flexible Mongo storage means
old records may still contain old fields.

## Verification

Minimum backend check:

```bash
npm run build
```

Suggested smoke tests:

```bash
curl http://localhost:3001/api/health
curl 'http://localhost:3001/api/entities/Claim?limit=1'
```

For file or extraction changes, also test:

- private upload
- signed URL creation
- local PDF extraction with `med-services/services.py` running
- S3/Textract path if AWS variables are configured

## Sensitive Data

This API handles medical billing data. Treat patient names, dates of birth,
claims, EOBs, PDFs, insurance data, and payments as sensitive.

Do not log PHI in new backend code. Do not expose raw stack traces, secrets,
storage paths, or provider errors to end users. Keep uploads private unless a
file is intentionally public.
