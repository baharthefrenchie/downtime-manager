/**
 * The detail panel and the cancel/extend dialogs (downtimes and SLO corrections),
 * loaded together on first use. They share DRUIDS dialog code, so keeping them in one lazily loaded module
 * avoids a separate library-only chunk.
 */
export { DetailPanel } from './DetailPanel';
export { CancelCorrectionModal, CancelDowntimeModal, ExtendCorrectionModal, ExtendDowntimeModal } from './DowntimeModals';
