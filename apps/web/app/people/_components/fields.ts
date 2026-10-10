// Which part of a record a correction request is about (people.correction_requests.field).
// Its own module: a Next.js page file may export nothing but its page.
export const FIELD_LABEL: Record<string, string> = {
  full_name: 'Name', work_email: 'Work email', department: 'Department', designation: 'Designation',
  location: 'Location', reports_to: 'Who I report to', joined_on: 'Date I joined', other: 'Something else',
};
