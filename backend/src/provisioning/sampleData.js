'use strict';

/**
 * Deterministic practice dataset for the `mongodb_practice` database.
 * Every document has a fixed _id so seeding is idempotent and tests are predictable.
 * Functions return fresh copies so callers can never mutate the canonical data.
 */
const { ObjectId } = require('mongodb');

// e.g. oid('65a1', 3) -> ObjectId('65a100000000000000000003')
const oid = (tag, n) => new ObjectId(`${tag}${'0'.repeat(20 - tag.length)}${String(n).padStart(4, '0')}`);
const STUDENT_PREFIX = '65a1';
const PRODUCT_PREFIX = '65a2';
const ORDER_PREFIX = '65a3';
const EMPLOYEE_PREFIX = '65a4';
const COURSE_PREFIX = '65a5';

const studentId = (n) => oid(STUDENT_PREFIX, n);
const productId = (n) => oid(PRODUCT_PREFIX, n);

function students() {
  return [
    ['Aarav Sharma', 'aarav.sharma@example.com', 20, 'Full Stack Development', 78, true],
    ['Diya Patel', 'diya.patel@example.com', 22, 'Data Science', 91, true],
    ['Rohan Gupta', 'rohan.gupta@example.com', 19, 'Full Stack Development', 64, true],
    ['Ananya Reddy', 'ananya.reddy@example.com', 24, 'Cloud Computing', 88, true],
    ['Vikram Singh', 'vikram.singh@example.com', 21, 'Data Science', 55, false],
    ['Meera Nair', 'meera.nair@example.com', 23, 'Cyber Security', 72, true],
    ['Kabir Khan', 'kabir.khan@example.com', 25, 'Cloud Computing', 95, true],
    ['Isha Verma', 'isha.verma@example.com', 20, 'Full Stack Development', 69, false],
    ['Arjun Mehta', 'arjun.mehta@example.com', 22, 'Cyber Security', 83, true],
    ['Sneha Iyer', 'sneha.iyer@example.com', 21, 'Data Science', 90, true],
    ['Rahul Das', 'rahul.das@example.com', 26, 'Full Stack Development', 47, false],
    ['Priya Joshi', 'priya.joshi@example.com', 18, 'Cloud Computing', 76, true],
  ].map(([name, email, age, course, score, isActive], i) => ({
    _id: studentId(i + 1),
    name,
    email,
    age,
    course,
    score,
    isActive,
  }));
}

const PRODUCT_ROWS = [
  ['Laptop Pro 14', 'Electronics', 89999, 12, 4.7, true],
  ['Wireless Mouse', 'Electronics', 799, 150, 4.3, true],
  ['Mechanical Keyboard', 'Electronics', 3499, 45, 4.6, true],
  ['Noise Cancelling Headphones', 'Electronics', 12999, 8, 4.5, true],
  ['USB-C Cable', 'Electronics', 299, 300, 4.1, true],
  ['4K Monitor', 'Electronics', 27999, 15, 4.4, false],
  ['MongoDB: The Definitive Guide', 'Books', 1899, 40, 4.8, true],
  ['Clean Code', 'Books', 1499, 5, 4.9, true],
  ['JavaScript Patterns', 'Books', 999, 60, 4.2, true],
  ['Ergonomic Office Chair', 'Furniture', 15999, 10, 4.5, true],
  ['Standing Desk', 'Furniture', 24999, 4, 4.6, true],
  ['Bookshelf', 'Furniture', 5999, 25, 4.0, false],
  ['Cotton T-Shirt', 'Clothing', 499, 200, 3.9, true],
  ['Denim Jacket', 'Clothing', 2999, 18, 4.2, true],
  ['Yoga Mat', 'Sports', 1199, 75, 4.4, true],
  ['Football', 'Sports', 899, 0, 4.1, false],
];

function products() {
  return PRODUCT_ROWS.map(([name, category, price, stock, rating, isActive], i) => ({
    _id: productId(i + 1),
    name,
    category,
    price,
    stock,
    rating,
    isActive,
  }));
}

const line = (productNumber, quantity) => {
  const [name, , price] = PRODUCT_ROWS[productNumber - 1];
  return { productId: productId(productNumber), name, price, quantity };
};

function orders() {
  const rows = [
    // [orderNo, studentNo, lines, status, createdAt]
    [1001, 1, [line(2, 1), line(5, 2)], 'delivered', '2024-01-05T10:15:00Z'],
    [1002, 2, [line(1, 1)], 'delivered', '2024-01-18T14:30:00Z'],
    [1003, 3, [line(7, 1), line(9, 1)], 'shipped', '2024-02-02T09:00:00Z'],
    [1004, 4, [line(10, 1)], 'delivered', '2024-02-14T16:45:00Z'],
    [1005, 2, [line(3, 1), line(5, 1)], 'pending', '2024-02-27T11:20:00Z'],
    [1006, 6, [line(13, 3), line(14, 1)], 'cancelled', '2024-03-03T08:10:00Z'],
    [1007, 7, [line(4, 1), line(2, 1)], 'delivered', '2024-03-15T19:05:00Z'],
    [1008, 1, [line(15, 2)], 'shipped', '2024-03-28T12:00:00Z'],
    [1009, 9, [line(11, 1)], 'delivered', '2024-04-04T10:40:00Z'],
    [1010, 10, [line(8, 2), line(7, 1)], 'delivered', '2024-04-19T15:25:00Z'],
    [1011, 4, [line(6, 1)], 'cancelled', '2024-04-30T09:50:00Z'],
    [1012, 12, [line(16, 1), line(15, 1)], 'pending', '2024-05-06T13:35:00Z'],
    [1013, 7, [line(1, 1), line(3, 1)], 'delivered', '2024-05-21T17:10:00Z'],
    [1014, 3, [line(13, 2)], 'delivered', '2024-06-02T10:05:00Z'],
    [1015, 9, [line(12, 1), line(9, 2)], 'shipped', '2024-06-17T14:55:00Z'],
    [1016, 2, [line(4, 1)], 'delivered', '2024-06-25T18:20:00Z'],
  ];
  return rows.map(([no, studentNo, items, status, createdAt], i) => ({
    _id: oid(ORDER_PREFIX, i + 1),
    orderId: `ORD${no}`,
    studentId: studentId(studentNo),
    products: items.map((p) => ({ ...p })),
    totalAmount: items.reduce((sum, p) => sum + p.price * p.quantity, 0),
    status,
    createdAt: new Date(createdAt),
  }));
}

function employees() {
  return [
    ['Neha Kapoor', 'Engineering', 1450000, 6, ['JavaScript', 'Node.js', 'MongoDB'], true],
    ['Sanjay Rao', 'Engineering', 980000, 3, ['Python', 'Django', 'PostgreSQL'], true],
    ['Pooja Menon', 'Engineering', 1720000, 8, ['Java', 'Kubernetes', 'MongoDB'], true],
    ['Amit Kulkarni', 'Marketing', 720000, 4, ['SEO', 'Content Strategy'], true],
    ['Ritu Saxena', 'Marketing', 560000, 2, ['Social Media', 'Copywriting'], true],
    ['Farhan Ali', 'Sales', 650000, 5, ['Negotiation', 'CRM'], true],
    ['Lakshmi Pillai', 'Sales', 480000, 1, ['Lead Generation', 'CRM'], false],
    ['Deepak Yadav', 'HR', 610000, 7, ['Recruitment', 'Payroll'], true],
    ['Kavya Bhat', 'Finance', 890000, 4, ['Excel', 'Financial Modelling', 'SQL'], true],
    ['Manish Tiwari', 'Finance', 1120000, 9, ['Auditing', 'SQL', 'MongoDB'], true],
    ['Nisha Agarwal', 'Engineering', 760000, 2, ['React', 'TypeScript'], false],
    ['Gaurav Malhotra', 'HR', 530000, 3, ['Employee Relations'], true],
  ].map(([name, department, salary, experience, skills, isActive], i) => ({
    _id: oid(EMPLOYEE_PREFIX, i + 1),
    name,
    department,
    salary,
    experience,
    skills,
    isActive,
  }));
}

function courses() {
  return [
    ['MongoDB Basics', 'Databases', 12, 1999, 'beginner', true],
    ['Advanced Aggregation Pipelines', 'Databases', 18, 3499, 'advanced', true],
    ['Node.js Fundamentals', 'Backend', 20, 2499, 'beginner', true],
    ['Express.js REST APIs', 'Backend', 16, 2999, 'intermediate', true],
    ['React for Beginners', 'Frontend', 24, 2799, 'beginner', true],
    ['State Management with Redux', 'Frontend', 10, 1799, 'intermediate', false],
    ['Data Modeling in MongoDB', 'Databases', 14, 2599, 'intermediate', true],
    ['Kubernetes in Production', 'DevOps', 30, 4999, 'advanced', false],
    ['CI/CD Pipelines', 'DevOps', 12, 2199, 'intermediate', true],
    ['Python for Data Analysis', 'Data Science', 28, 3299, 'beginner', true],
    ['Machine Learning Foundations', 'Data Science', 36, 5999, 'advanced', true],
    ['System Design Essentials', 'Backend', 22, 4499, 'advanced', false],
  ].map(([title, category, duration, price, level, isPublished], i) => ({
    _id: oid(COURSE_PREFIX, i + 1),
    title,
    category,
    duration,
    price,
    level,
    isPublished,
  }));
}

const DATASET = { students, products, orders, employees, courses };

const INDEXES = {
  students: [
    { key: { email: 1 }, options: { unique: true, name: 'email_unique' } },
    { key: { course: 1, score: -1 }, options: { name: 'course_score' } },
  ],
  products: [
    { key: { category: 1, price: -1 }, options: { name: 'category_price' } },
    { key: { name: 1 }, options: { name: 'name_1' } },
  ],
  orders: [
    { key: { orderId: 1 }, options: { unique: true, name: 'orderId_unique' } },
    { key: { status: 1, createdAt: -1 }, options: { name: 'status_createdAt' } },
    { key: { studentId: 1 }, options: { name: 'studentId_1' } },
  ],
  employees: [
    { key: { department: 1, salary: -1 }, options: { name: 'department_salary' } },
    { key: { skills: 1 }, options: { name: 'skills_1' } },
  ],
  courses: [
    { key: { category: 1, level: 1 }, options: { name: 'category_level' } },
    { key: { title: 1 }, options: { unique: true, name: 'title_unique' } },
  ],
};

const PRACTICE_COLLECTIONS = Object.keys(DATASET);

const getDataset = () => Object.fromEntries(PRACTICE_COLLECTIONS.map((name) => [name, DATASET[name]()]));

module.exports = { getDataset, INDEXES, PRACTICE_COLLECTIONS, DATASET };
