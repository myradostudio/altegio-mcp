/**
 * Response fixtures shaped after the response schemas and examples of the
 * Altegio OpenAPI documents. All identifiers, names and numbers are made up.
 */

export const IDS = {
  location: 4564,
  otherLocation: 9001,
  form: 123,
  category: 1895571,
  haircut: 1896208,
  coloring: 1896303,
  staff: 6544,
  otherStaff: 6545,
  record: 2820023,
} as const;

export const RECORD_HASH = '567df655304da9b98487769426d4e76e';
export const SLOT = '2026-10-12T15:30:00.000+03:00';

export const location = {
  id: IDS.location,
  title: 'Студія «Приклад»',
  country_id: 2,
  country: 'Ukraine',
  city_id: 5,
  city: 'Kyiv',
  timezone_name: 'Europe/Kiev',
  address: 'вул. Прикладна, 1',
  zip: '01001',
  social: { telegram: '', instagram: 'example', facebook: '', viber: '', whatsapp: '' },
  site: 'https://example.com',
  coordinate_lat: 50.45,
  coordinate_lon: 30.52,
  phone_confirmation: false,
  active_staff_count: 2,
  group_priority: 0,
  main_group_id: 0,
  main_group: [],
  bookforms: [],
  payment_policy: { type: 'none' },
};

export const bookingForm = {
  id: IDS.form,
  url: 'https://b123.alteg.io',
  steps: [{ step: 'service', title: 'Select service', num: 1, default: '0', hidden: '0', date_hidden: '0', time_hidden: '0' }],
  style: { show_header: true, logo: '/uploads/logo.png', main_color: 'blue' },
  group_id: 0,
  company_id: IDS.location,
  phone_confirmation: true,
  lang: 'uk-UA',
  langs: [{ id: 1, code: 'uk-UA', title: 'Українська' }],
  comment_required: false,
  google_analytics_id: 'UA-000000-0',
  facebook_pixel_id: '',
  sms_enabled: true,
};

export const services = {
  events: [],
  services: [
    {
      id: IDS.haircut,
      title: 'Стрижка жіноча',
      category_id: IDS.category,
      price_min: 600,
      price_max: 900,
      discount: 0,
      comment: '',
      weight: 10,
      active: 1,
      gender: 0,
      image: 'https://example.com/haircut.png',
      prepaid: 'forbidden',
      seance_length: 3600,
    },
    {
      id: IDS.coloring,
      title: 'Фарбування',
      category_id: 1895574,
      price_min: 1500,
      price_max: 3000,
      discount: 10,
      comment: 'Ціна залежить від довжини',
      weight: 5,
      active: 1,
      gender: 0,
      image: '',
      prepaid: 'allowed',
      seance_length: 7200,
    },
  ],
  category: [
    { id: IDS.category, title: 'Стрижки', gender: 0, api_id: 0, weight: 60 },
    { id: 1895574, title: 'Фарбування волосся', gender: 0, api_id: 0, weight: 7 },
  ],
};

export const staff = [
  {
    id: IDS.staff,
    api_id: null,
    user_id: null,
    name: 'Олена',
    bookable: true,
    specialization: 'Перукар',
    position: { id: 1, title: 'Топ-стиліст' },
    show_rating: 1,
    rating: 4.9,
    votes_count: 12,
    avatar: 'https://example.com/a.png',
    avatar_big: 'https://example.com/a-big.png',
    comments_count: 7,
    weight: 10,
    information: '<p>Десять років досвіду</p>',
    seance_date: '2026-10-12',
    schedule_till: '2026-11-30',
    seances: [],
    fired: 0,
    status: 0,
    hidden: 0,
    prepaid: 'forbidden',
  },
  {
    id: IDS.otherStaff,
    api_id: null,
    user_id: null,
    name: 'Марія',
    bookable: false,
    specialization: 'Колорист',
    position: [],
    show_rating: 0,
    rating: 0,
    votes_count: 0,
    avatar: '',
    avatar_big: '',
    comments_count: 0,
    weight: 5,
    information: '',
    seances: [],
    fired: 0,
    status: 0,
    hidden: 0,
    prepaid: 'forbidden',
  },
];

export const dates = {
  booking_days: { '10': [13, 12], '11': [2] },
  booking_dates: ['2026-10-13', '2026-10-12', '2026-11-02'],
  working_days: { '10': [12, 13, 14], '11': [2] },
  working_dates: ['2026-10-14', '2026-10-12', '2026-10-13', '2026-11-02'],
};

export const slots = [
  { time: '15:30', seance_length: 3600, sum_length: 3600, datetime: SLOT },
  { time: '16:30', seance_length: 3600, sum_length: 3600, datetime: '2026-10-12T16:30:00.000+03:00' },
];

export const nearestSlots = { seance_date: '2026-10-12', seances: slots };

export const booking = {
  id: IDS.record,
  services: [
    { id: IDS.haircut, title: 'Стрижка жіноча', amount: 1, seance_length: 3600, cost: 600, price_min: 600, price_max: 900, discount: 0 },
  ],
  company: {
    id: IDS.location,
    title: 'Студія «Приклад»',
    country_id: 2,
    country: 'Ukraine',
    city_id: 5,
    city: 'Kyiv',
    phone: '+380441234567',
    phones: [],
    timezone: '3',
    address: 'вул. Прикладна, 1',
    coordinate_lat: 50.45,
    coordinate_lon: 30.52,
    allow_delete_record: true,
    allow_change_record: false,
    site: 'https://example.com',
    currency_short_title: '₴',
    allow_change_record_delay_step: 0,
    allow_delete_record_delay_step: 0,
  },
  staff: {
    id: IDS.staff,
    name: 'Олена',
    specialization: 'Перукар',
    position: { id: 1, title: 'Топ-стиліст' },
    show_rating: 1,
    rating: 4.9,
    votes_count: 12,
    avatar: 'https://example.com/a.png',
    comments_count: 7,
  },
  clients_count: 1,
  date: '2026-10-12T12:30:00Z',
  datetime: SLOT,
  create_date: '2026-10-08T09:00:00Z',
  comment: 'Перший візит',
  deleted: false,
  attendance: 0,
  length: 3600,
  notify_by_sms: 0,
  notify_by_email: 0,
  master_requested: true,
  online: true,
  api_id: 'order-77',
  last_change_date: '2026-10-08T09:00:00Z',
  prepaid: false,
  prepaid_confirmed: false,
  activity_id: 0,
};

export const createdBooking = [{ id: 1, record_id: IDS.record, record_hash: RECORD_HASH }];

/** `meta.errors` entries copied from the example of the 422 response of book_check. */
export const slotTaken = {
  code: 433,
  message: 'Team Member (0) cannot be booked on October 12, 2026 at 15:30. The selected time is already taken or is not working.',
};
