# Manual Test Matrix

Use this matrix for release-candidate smoke testing. For every scenario, capture:

- Input assets used (model + texture file names).
- Validation messages shown in UI (warnings/errors/clears).
- Export outcome (success/failure + any fallback notices).
- Final verdict using the pass/fail criteria below.

## 1) Model Loading

| Scenario ID | Scenario | Setup / Input | Expected validation output | Expected export behavior | Pass criteria | Fail criteria |
|---|---|---|---|---|---|---|
| ML-01 | Tiny manifold mesh | Load a very small but valid manifold STL (e.g., miniature calibration mesh). | Validation reports **valid/manifold** with no critical errors; any scale notice is informational only. | Export succeeds with geometry preserved and no forced repair warning. | Mesh loads, preview renders, and STL export completes without warnings that block export. | Load fails, manifold mesh is flagged invalid, or export is blocked unexpectedly. |
| ML-02 | Huge manifold mesh | Load a very large manifold STL close to practical triangle limits. | Validation completes and indicates model is processable; may include performance/complexity warning but not fatal. | Export succeeds or respects configured triangle cap with expected reduction notice. | UI remains responsive enough to complete flow; export result matches configured limits. | Browser lockup/crash, incorrect fatal validation, or export ignores configured limits. |
| ML-03 | Non-manifold mesh | Load STL with known non-manifold edges/self-intersections. | Validation explicitly flags non-manifold condition (warning or error per product behavior). | Export either blocks with clear reason or proceeds only with documented fallback/repair path. | Message is explicit and actionable; export behavior matches documented policy. | Non-manifold condition is missed, mislabeled, or produces silent corrupt export. |
| ML-04 | Multi-shell model | Load STL containing multiple disconnected shells/bodies. | Validation indicates multi-shell/disconnected components (or equivalent topology warning/info). | Export preserves all shells unless user chooses a reduction mode that intentionally removes detail. | Shell count/structure visibly preserved in preview/export when no destructive option is enabled. | Missing shells, merged artifacts, or silent shell drops in output. |

## 2) Texture Loading

| Scenario ID | Scenario | Setup / Input | Expected validation output | Expected export behavior | Pass criteria | Fail criteria |
|---|---|---|---|---|---|---|
| TX-01 | Grayscale texture | Load single-channel grayscale texture map. | Validation accepts texture format and reports ready state; no color-space error. | Export displacement/relief uses grayscale values consistently. | Visible displacement corresponds to grayscale intensity; export succeeds. | Texture rejected incorrectly, flat/no displacement, or severe banding beyond expected. |
| TX-02 | Color texture | Load RGB(A) texture image. | Validation accepts color texture and confirms conversion path (e.g., luminance extraction) if applicable. | Export applies expected channel interpretation (documented luminance/height behavior). | Preview and export show consistent relief derived from color texture. | Channel misread, inverted mapping unexpectedly, or export mismatch vs preview. |
| TX-03 | Low dynamic range | Use low-contrast texture with narrow intensity range. | Validation succeeds; may provide low-contrast warning/info if implemented. | Export shows subtle but non-zero displacement; no clipping artifacts from normalization. | Output has gentle relief and no abrupt plateaus caused by pipeline error. | Output appears fully flat or clipped due to incorrect intensity handling. |
| TX-04 | Non-tileable seams | Apply visibly non-seamless texture to wrapped/continuous surface. | Validation should not fail; may warn about seam risk when wrapping/tiling is enabled. | Export preserves expected seam location/visibility (no hidden geometry corruption). | Seam artifact is predictable and limited to UV boundary behavior. | Unexpected tearing, spikes, or topology corruption near seam. |
| TX-05 | Odd resolutions | Load textures with unusual dimensions (e.g., 257×509, very wide, very tall). | Validation accepts supported odd sizes and reports any resizing/resampling action. | Export uses processed texture without distortion beyond expected resampling. | Preview/export aspect behavior is stable and documented resizing is reflected. | Load fails for valid file, extreme distortion, or silent incorrect resample. |

## 3) Export Settings

| Scenario ID | Scenario | Setup / Input | Expected validation output | Expected export behavior | Pass criteria | Fail criteria |
|---|---|---|---|---|---|---|
| EX-01 | Extreme refine length (very low) | Set refine length to minimum/near-minimum allowed value. | Validation accepts value or clamps with explicit message. | Export shows high refinement density within triangle limits. | Output complexity increases as expected and process completes successfully. | Value ignored silently, unstable output, or crash/timeouts without guidance. |
| EX-02 | Extreme refine length (very high) | Set refine length to maximum/near-maximum allowed value. | Validation accepts/clamps and indicates coarse refinement effect if out of range. | Export produces coarser surface while preserving overall form. | Triangle density decreases predictably; no topology breakage. | Gross deformation, non-deterministic output, or ignored refine parameter. |
| EX-03 | Max triangles very low | Set max triangles to a small cap likely below source complexity. | Validation warns that decimation/reduction will be significant. | Export respects cap and completes with reduced detail. | Exported mesh triangle count is at/below cap and file is valid. | Count exceeds cap or export fails without clear cause. |
| EX-04 | Max triangles very high | Set max triangles near upper allowed bound. | Validation accepts value, may warn about performance/memory. | Export retains more detail and remains valid if system resources permit. | Detail preservation improves and export completes under expected time/resource envelope. | Hard failure despite supported range or incorrect auto-downscale without notice. |
| EX-05 | Vase mode toggles | Run same input with vase mode OFF then ON. | Validation reflects each mode state and any compatibility warnings. | OFF: standard solid/shell export. ON: vase-appropriate geometry behavior per design intent. | Mode toggle causes expected, reproducible geometry differences. | Toggle has no effect, inverted effect, or invalid mesh in either mode. |

## 4) Worker Availability / Failure Fallback

| Scenario ID | Scenario | Setup / Input | Expected validation output | Expected export behavior | Pass criteria | Fail criteria |
|---|---|---|---|---|---|---|
| WK-01 | Worker available | Run in normal environment where worker script loads successfully. | Validation/logs indicate worker path active (if surfaced). | Export uses worker-backed processing and completes normally. | No fallback warnings; performance matches baseline worker behavior. | Unexpected fallback despite worker availability. |
| WK-02 | Worker initialization failure | Simulate worker creation failure (e.g., blocked script, CSP/test harness). | Validation/logs show explicit worker failure and fallback selection. | Export continues via main-thread (or alternate) fallback with preserved correctness. | User receives clear notice; export still succeeds with potential performance penalty. | Silent failure, hung UI, or aborted export without fallback messaging. |
| WK-03 | Mid-process worker error | Trigger runtime error inside worker during processing. | Validation/logs capture worker error event and fallback/abort decision. | Export either retries via fallback or fails fast with actionable error text. | Behavior is deterministic, user-informed, and no corrupted partial file is produced. | App freezes, repeated retry loop, or corrupted output file generation. |

## 5) Precision Masking + Export Parity

| Scenario ID | Scenario | Setup / Input | Expected validation output | Expected export behavior | Pass criteria | Fail criteria |
|---|---|---|---|---|---|---|
| PM-01 | Masked vs unmasked control | Export once with precision mask disabled and once enabled on known regions. | Validation confirms mask presence/coverage and no out-of-range mask values. | Masked export alters only intended regions; unmasked export remains baseline. | Region-level differences match mask boundaries without bleed into excluded areas. | Mask has no effect, global effect, or inverted inclusion/exclusion. |
| PM-02 | Re-export parity (same settings) | Repeat export twice with identical mask/settings. | Validation outputs equivalent state both runs. | Resulting meshes are identical or within documented deterministic tolerance. | No unexpected drift in vertex displacement or topology across repeats. | Non-deterministic differences beyond tolerance with unchanged inputs. |
| PM-03 | Preview/export parity | Compare masked preview appearance against final exported STL. | Validation indicates no pending/dirty state prior to export. | Exported geometry matches previewed masked displacement pattern. | Visual and measured parity between preview and exported mesh in masked zones. | Clear mismatch between preview and exported result. |

## 6) `file://` Behavior + Local-Server Guidance

| Scenario ID | Scenario | Setup / Input | Expected validation output | Expected export behavior | Pass criteria | Fail criteria |
|---|---|---|---|---|---|---|
| FL-01 | App opened via `file://` | Launch app directly from local filesystem URL. | Validation/UI shows clear guidance that certain features may require HTTP(S) context. | Export behavior follows product policy (allowed with limits, or blocked with message). | User is explicitly guided to run a local server when required. | Silent malfunction or generic error without `file://`-specific guidance. |
| FL-02 | Guided local-server flow | From `file://` warning, follow documented local server instructions and reload via localhost. | Validation warning clears (or downgrades) once served over local HTTP origin. | Export and worker-dependent features operate normally under localhost. | Transition from blocked/degraded to normal behavior is obvious and successful. | Warning persists incorrectly or features still fail despite proper local server setup. |
| FL-03 | Unsupported mixed context edge case | Attempt combinations likely restricted in `file://` mode (e.g., worker + external resource). | Validation reports specific blocked capability and remediation guidance. | Export either gracefully degrades or blocks with actionable steps. | No crash; user gets precise next-step instructions. | Hard crash, opaque console-only errors, or inconsistent behavior without UI explanation. |

## Test Execution Notes

- Capture screenshots for each failed case and include browser console excerpts when worker or `file://` scenarios fail.
- Record the exact app commit SHA and browser version used for reproducibility.
- If behavior intentionally differs by browser, annotate expected/observed results per browser in the test log.
