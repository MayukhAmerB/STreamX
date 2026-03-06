export const featuredCourse = {
  id: 1,
  title: "OSINT for Cyber security and Web Application Penetration Testing",
  slug: "osint-for-cyber-security-and-web-application-penetration-testing",
  description:
    "A practical, workflow-driven course covering reconnaissance, open-source intelligence collection, target profiling, attack surface mapping, and web application penetration testing methodology for real-world security assessments.",
  thumbnail:
    "https://images.unsplash.com/photo-1518773553398-650c184e0bb3?auto=format&fit=crop&w=1400&q=80",
  price: 7999,
  is_published: true,
  section_count: 5,
  instructor: {
    id: 1,
    full_name: "Al syed Initiative",
    email: "instructor@alsyedinitiative.local",
  },
  learning_points: [
    "Target discovery and attack surface mapping with OSINT workflows",
    "Subdomain enumeration and recon prioritization for web testing",
    "Web application penetration testing methodology from recon to validation",
    "Evidence collection, reporting discipline, and ethical boundaries",
  ],
  sections: [
    {
      id: 101,
      title: "Module 1: OSINT Foundations & Scope",
      order: 1,
      lectures: [
        { id: 1001, title: "Course roadmap and ethical boundaries", is_preview: true },
        { id: 1002, title: "Recon mindset: passive vs active intelligence", is_preview: false },
      ],
    },
    {
      id: 102,
      title: "Module 2: Domain & Attack Surface Enumeration",
      order: 2,
      lectures: [
        { id: 1003, title: "Subdomain discovery workflow", is_preview: false },
        { id: 1004, title: "Tech stack fingerprinting and prioritization", is_preview: false },
      ],
    },
    {
      id: 103,
      title: "Module 3: Web App Recon for Pentesting",
      order: 3,
      lectures: [
        { id: 1005, title: "Endpoint discovery and parameter mapping", is_preview: false },
        { id: 1006, title: "Authentication surface and access-control review", is_preview: false },
      ],
    },
    {
      id: 104,
      title: "Module 4: Testing Workflow & Validation",
      order: 4,
      lectures: [
        { id: 1007, title: "From recon findings to test cases", is_preview: false },
        { id: 1008, title: "Triaging and validating impact safely", is_preview: false },
      ],
    },
    {
      id: 105,
      title: "Module 5: Documentation & Reporting",
      order: 5,
      lectures: [
        { id: 1009, title: "Evidence collection and note-taking structure", is_preview: false },
        { id: 1010, title: "Final report drafting and remediation guidance", is_preview: false },
      ],
    },
  ],
};

export function getFeaturedCourseFallback() {
  return featuredCourse;
}

