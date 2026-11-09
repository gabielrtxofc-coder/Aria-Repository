/**
 * The single seam between the prototype and the DSH `ui-primitives` package.
 *
 * Screens import their atoms from here, never from the package directly, so
 * every reused control is listed in one place: the inventory a reviewer needs
 * to see what the prototype inherits from DSH and what it adds. The import path
 * itself is `../atoms.ts`, which resolves the same list from the source files of
 * `@deepseek-ai/dsh-client-ui-primitives` without loading its whole barrel.
 */

export {
  Button, IconArchiveOutlineRegular, IconCheckCircleOutlineRegular, IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular, IconClockOutlineRegular, IconCloseOutlineRegular, IconInfoOutlineRegular,
  IconLoadingOutlineRegular, IconPanelLeftOutlineRegular, IconRefreshOutlineRegular, IconSearchOutlineRegular,
  IconShieldOutlineRegular, IconSparkleRegular, IconUsersOutlineRegular, IconWarningOutlineRegular,
  Input, Modal, Switch, Tag,
} from '../atoms.ts'
export type { TagTone } from '../atoms.ts'
