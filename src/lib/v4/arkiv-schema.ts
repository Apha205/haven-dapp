/**
 * Arkiv 1.x schema for haven-dapp's drip entities
 * (`haven.video.drip.series` / `haven.video.drip.part`) and any other
 * `haven.*` group this app writes. One untagged schema covers all groups:
 * readers select attributes by name and tolerate missing columns, and
 * writers only set the columns their record kind uses — every column a
 * given record kind omits is `.optional()`.
 *
 * `payload` carries the JSON body as `bytes`; `content_type` is a `str`
 * column. There is no `$payload`/`$contentType` field in 1.x — both are
 * attributes. Column types match the workspace wire convention (bare
 * values: `str`/`i32`/`u256`) so type-exact queries hit entities written
 * by any Haven surface — see `lib/arkiv-attrs`.
 */
import { bytes, defineSchema, i32, str, u256, type Schema } from '@arkiv-network/sdk/schema'

export const HAVEN_SCHEMA: Schema = defineSchema({
  grp: str().indexed(),
  title: str().optional(),
  gate_type: i32(),
  gate_token: str().optional(),
  gate_chain: i32().optional(),
  gate_threshold: u256().optional(),
  gate_epoch: i32().optional(),
  sha256_ct: str().indexed().optional(),
  mime: i32().optional(),
  dur_s: i32().optional(),
  drip_id: str().indexed(),
  drip_total: i32().optional(),
  drip_idx: i32().optional(),
  series_ref: str().indexed().optional(),
  mcap_usd: i32().optional(),
  content_type: str(),
  payload: bytes(),
})
