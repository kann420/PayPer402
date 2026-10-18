// Side-effect module, imported before `ag-studio` so the filter is in place before Studio loads
// or first renders (design spec §11.1). It does nothing in production.
import { installLicenceBannerFilter } from '@/lib/licence-banner';

installLicenceBannerFilter();
