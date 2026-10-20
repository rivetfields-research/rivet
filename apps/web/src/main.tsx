import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './workspace';
import { OrganizationAdminApp, OrganizationJoinApp } from './organization-admin';
import { CustomerWorkspaceGate, CustomerWorkspacePicker } from './customer-workspaces';
import { FileUploadFeedback } from './file-upload-feedback';
import { SignupTour } from './signup-tour';
import { TeamAdminApp } from './team-admin';
import { BillingOnboardingApp } from './billing';
import { OnboardingApp } from './onboarding';
import './billing.css';
import './onboarding.css';
import './styles.css';
import './workspace-diagnostics.css';
import './source-table.css';
import './organization-admin.css';
import './workspace-access-layout.css';

const billingMode = document.querySelector('meta[name="rivet-test-billing"]')?.getAttribute('content');
const billingRoute = billingMode === 'hosted' && location.pathname === '/billing-test' ||
  billingMode === 'local' && ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname) && location.pathname === '/onboarding';
const Screen = billingRoute ? BillingOnboardingApp : location.pathname === '/onboarding' ? OnboardingApp : location.pathname === '/admin' ? OrganizationAdminApp : location.pathname === '/team' ? TeamAdminApp : ['/join', '/join/complete'].includes(location.pathname) ? OrganizationJoinApp : location.pathname === '/workspaces' ? CustomerWorkspacePicker : App;
createRoot(document.getElementById('root')!).render(<React.StrictMode>{location.pathname.startsWith('/w/') ? <CustomerWorkspaceGate><App/><SignupTour/></CustomerWorkspaceGate> : <><Screen/>{Screen === App && <SignupTour/>}</>}<FileUploadFeedback/></React.StrictMode>);
