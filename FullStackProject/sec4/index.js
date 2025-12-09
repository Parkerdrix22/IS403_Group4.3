require('dotenv').config();

const express = require("express");

const session = require("express-session");

const knex = require("knex")({
    client: "pg",
    connection: {
        host: process.env.RDS_HOSTNAME || "awseb-e-cmnauwhany-stack-awsebrdsdatabase-tj12s5abic9x.cb8eie2ew4fz.us-east-2.rds.amazonaws.com",
        user: process.env.RDS_USERNAME || "project3",
        password: process.env.RDS_PASSWORD || "project123",
        database: process.env.RDS_DB_NAME || "ebdb",
        port: process.env.RDS_PORT || 5432,
        ssl: process.env.DB_SSL === 'false' ? false : {rejectUnauthorized: false} 
    }
});

let path = require("path");
let bodyParser = require("body-parser");

let app = express();

app.set("view engine", "ejs");

const port = process.env.PORT || 3000;

app.use(
    session(
        {
            secret: process.env.SESSION_SECRET || 'fallback-secret-key',
            resave: false,
            saveUninitialized: false,
        }
    )
);

app.use(express.urlencoded({extended: true}));
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, 'public')));

// Default survey questions (fallback)
const DEFAULT_SURVEY_QUESTIONS = [
	"How clear was the content presented?",
	"How spiritually uplifting did you feel during this lesson?",
	"How well did the instructor engage the class?"
];

// Helper function to get user info
function getUserInfo(req) {
    if (!req.session.isLoggedIn) {
        return null;
    }
    return {
        username: req.session.username,
        memberid: req.session.memberid,
        memberfirstname: req.session.memberfirstname,
        memberlastname: req.session.memberlastname,
        memberlevel: req.session.memberlevel,
        isManager: req.session.isManager || false
    };
}

// Helper to fetch survey questions for a lesson (definitions stored as rows with memberid null)
async function getSurveyQuestionsForLesson(lessonId) {
	try {
		const defs = await knex('survey_response')
			.select('question', 'extracomments')
			.where('lessonid', lessonId)
			.whereNull('response') // definition rows marked by response NULL
			.orderByRaw("COALESCE(NULLIF(extracomments, '')::int, 0)");

		if (defs && defs.length > 0) {
			return defs.map(d => d.question);
		}
	} catch (err) {
		console.error('Error fetching survey questions for lesson', lessonId, err);
	}
	return DEFAULT_SURVEY_QUESTIONS;
}

// Helper function to format date from yyyy-mm-dd to readable format
function formatDate(dateValue) {
    if (!dateValue) return 'N/A';
    
    try {
        let date;
        // Handle different date formats from database
        if (dateValue instanceof Date) {
            date = dateValue;
        } else if (typeof dateValue === 'string') {
            // PostgreSQL returns dates as strings in YYYY-MM-DD format
            // Remove any time portion if present
            const dateStr = dateValue.split('T')[0].split(' ')[0];
            // Parse YYYY-MM-DD format
            const parts = dateStr.split('-');
            if (parts.length === 3) {
                date = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
            } else {
                date = new Date(dateStr);
            }
        } else {
            date = new Date(dateValue);
        }
        
        // Check if date is valid
        if (isNaN(date.getTime())) {
            console.error('Invalid date:', dateValue);
            return 'N/A';
        }
        
        const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
        return date.toLocaleDateString('en-US', options);
    } catch (error) {
        console.error('Error formatting date:', dateValue, error);
        return 'N/A';
    }
}

app.use((req, res, next) => {
    // Allow access to public pages (login, signup, lessons, surveys)
    if (
        req.path === '/' ||
        req.path === '/login' ||
        req.path === '/signup' ||
        req.path === '/upcoming-lesson' ||
        req.path.startsWith('/upcoming-lesson/') ||
        req.path === '/survey' ||
        req.path.startsWith('/survey/') ||
        req.path === '/feedback' // allow feedback landing to redirect to login as needed
    ) {
        return next();
    }
    
    if (req.session.isLoggedIn) {
        next();
    } else {
        res.render("login", { error_message: "Please log in to access this page"});
    }      
});

app.get("/", (req, res) => {
    res.render("login");
});

app.get("/login", (req, res) => {
	// Always show the login page
	res.render("login", { error_message: "" });
});

// Signup route - GET
app.get("/signup", (req, res) => {
	res.render("login", { error_message: "", show_signup: true });
});

// Signup route - POST
app.post("/signup", async (req, res) => {
	const { firstName, lastName, phone, email, username, password, memberlevel } = req.body;
	
	console.log("Signup attempt:", { firstName, lastName, phone, email, username, memberlevel });
	
	// Validate required fields
	if (!firstName || !lastName || !phone || !email || !username || !password || !memberlevel) {
		console.log("Validation failed - missing fields");
		return res.render("login", { 
			error_message: "All fields are required", 
			show_signup: true 
		});
	}
	
	try {
		// Check if email already exists
		const existingEmail = await knex('members')
			.where('memberemail', email)
			.first();
		if (existingEmail) {
			console.log("Email already exists:", email);
			return res.render("login", {
				error_message: "Email already in use. Please use a different email.",
				show_signup: true
			});
		}

		// Check if username already exists
		const existingUser = await knex('login')
			.where('username', username)
			.first();
		
		if (existingUser) {
			console.log("Username already exists:", username);
			return res.render("login", { 
				error_message: "Username already exists. Please choose a different username.", 
				show_signup: true 
			});
		}
		
		// Step 1: Insert into members table
		console.log("Inserting into members table...");
		const newMembers = await knex('members')
			.insert({
				memberfirstname: firstName,
				memberlastname: lastName,
				memberphonenumber: phone,
				memberemail: email,
				memberlevel: memberlevel
			})
			.returning('memberid');
		
		console.log("Members insert result:", newMembers);
		
		// Check if insert was successful
		if (!newMembers || newMembers.length === 0) {
			console.error("Failed to insert into members table");
			return res.render("login", { 
				error_message: "Error creating account. Please try again.", 
				show_signup: true 
			});
		}
		
		// Get the memberid from the insert
		const memberid = newMembers[0].memberid;
		console.log("Got memberid:", memberid);
		
		if (!memberid) {
			console.error("No memberid returned from insert");
			return res.render("login", { 
				error_message: "Error creating account. Please try again.", 
				show_signup: true 
			});
		}
		
		// Step 2: Insert into login table using the memberid
		console.log("Inserting into login table with memberid:", memberid);
		// login.memberid appears to be GENERATED ALWAYS; override to keep FK link
		await knex.raw(
			`insert into login (memberid, username, password) overriding system value values (?, ?, ?)`,
			[memberid, username, password]
		);
		
		console.log("Signup successful!");
		
		// Success - show success message
		res.render("login", { 
			error_message: "", 
			success_message: "Account created successfully! Please log in." 
		});
		
	} catch (err) {
		console.error("Signup error:", err);
		console.error("Error details:", err.message);
		console.error("Error stack:", err.stack);
		res.render("login", { 
			error_message: `Error creating account: ${err.message}. Please try again.`, 
			show_signup: true 
		});
	}
});

// This creates attributes in the session object to keep track of user and if they logged in
app.post("/login", (req, res) => {
	let sName = req.body.username;
	let sPassword = req.body.password;
	knex.select("login.memberid", "login.username", "login.password", 
				"members.memberfirstname", "members.memberlastname", "members.memberlevel")
		.from('login')
		.join('members', 'login.memberid', '=', 'members.memberid')
		.where("login.username", sName)
		.andWhere("login.password", sPassword)
		.then(users => {
			// Check if a user was found with matching username AND password
			if (users.length > 0) {
		req.session.isLoggedIn = true;
				req.session.username = sName;
				req.session.memberid = users[0].memberid || null;
				req.session.memberfirstname = users[0].memberfirstname || null;
				req.session.memberlastname = users[0].memberlastname || null;
				req.session.memberlevel = users[0].memberlevel || null;
				// Set manager/admin access based on memberlevel
				req.session.isManager = users[0].memberlevel === "Teacher";
				res.redirect("/dashboard");
			} else {
				// No matching user found
				res.render("login", { error_message: "Invalid login" });
			}
		})
		.catch(err => {
			console.error("Login error:", err);
			res.render("login", { error_message: "Invalid login" });
		});
});

app.get("/test", (req, res) => {
    res.render("test");
});

app.get("/dashboard", (req, res) => { // Also accessible as /home
	const userInfo = getUserInfo(req);
	
	// Get today's date in YYYY-MM-DD format
	const today = new Date();
	const todayStr = today.toISOString().split('T')[0];
	
	// Get the lesson with the date closest to today (soonest upcoming)
	knex.select(
			'lesson.lessonid',
			'lesson.lessontitle',
			'lesson.lessondate',
			'lesson.classroom',
			'lesson.topic',
			'lesson.lessonoverview',
			'lesson.readingmaterials',
			'lesson.discussionquestions',
			'lesson.memberid',
			'members.memberfirstname',
			'members.memberlastname'
		)
		.from('lesson')
		.leftJoin('members', 'lesson.memberid', '=', 'members.memberid')
		.where('lesson.lessondate', '>=', todayStr)
		.orderBy('lesson.lessondate', 'asc')
		.limit(1)
		.first()
		.then(lesson => {
			let upcomingLesson = null;
			if (lesson) {
				upcomingLesson = {
					lessonid: lesson.lessonid,
					lessonname: lesson.lessontitle,
					date: formatDate(lesson.lessondate),
					location: lesson.classroom,
					topics: lesson.topic,
					description: lesson.lessonoverview,
					reading: lesson.readingmaterials,
					discussion: lesson.discussionquestions,
					teacher: lesson.memberfirstname && lesson.memberlastname 
						? `${lesson.memberfirstname} ${lesson.memberlastname}` 
						: 'N/A'
				};
			}
			res.render("index", { 
				user: userInfo,
				upcomingLesson: upcomingLesson
			});
		})
		.catch(err => {
			console.error('Error fetching upcoming lesson:', err);
			res.render("index", { 
				user: userInfo,
				upcomingLesson: null
			});
		});
});

// Survey responses summary (Teacher only)
app.get("/survey-responses", async (req, res) => {
	const userInfo = getUserInfo(req);
	if (!userInfo || !userInfo.isManager) {
		return res.redirect("/dashboard");
	}

	try {
		// Lessons
		const lessons = await knex('lesson')
			.select('lessonid', 'lessontitle', 'lessondate')
			.orderBy('lessondate', 'desc');

		// Survey question definitions (response null) joined to lesson
		const definitions = await knex('survey_response as sr')
			.select('sr.lessonid', 'sr.question', 'sr.extracomments')
			.whereNull('sr.response');

		// Per-question averages joined to lesson
		const averages = await knex('survey_response as sr')
			.select('sr.lessonid', 'sr.question')
			.avg({ avg_response: 'sr.response' })
			.whereNotNull('sr.response')
			.groupBy('sr.lessonid', 'sr.question');

		// Overall lesson average (across all questions)
		const lessonAverages = await knex('survey_response as sr')
			.select('sr.lessonid')
			.avg({ avg_response: 'sr.response' })
			.whereNotNull('sr.response')
			.groupBy('sr.lessonid');

		const lessonsWithQuestions = lessons.map(lesson => {
			// merge definitions and any questions that only exist in responses
			const defs = definitions
				.filter(d => d.lessonid === lesson.lessonid)
				.sort((a, b) => {
					const ai = parseInt(a.extracomments || '0', 10);
					const bi = parseInt(b.extracomments || '0', 10);
					return ai - bi;
				});

			// Collect all question texts from defs or responses
			const questionsSet = new Set(defs.map(d => d.question));
			averages
				.filter(a => a.lessonid === lesson.lessonid)
				.forEach(a => questionsSet.add(a.question));

			const orderedQuestions = Array.from(questionsSet).map((q, idx) => {
				const avg = averages.find(a => a.lessonid === lesson.lessonid && a.question === q);
				return {
					text: q,
					average: avg ? Number(avg.avg_response).toFixed(2) : '—'
				};
			});

			const overall = lessonAverages.find(a => a.lessonid === lesson.lessonid);

			return {
				lessonid: lesson.lessonid,
				lessonname: lesson.lessontitle,
				date: formatDate(lesson.lessondate),
				overallAverage: overall ? Number(overall.avg_response).toFixed(2) : '—',
				questions: orderedQuestions
			};
		});

		res.render("survey-responses", {
			user: userInfo,
			lessons: lessonsWithQuestions,
			error_message: ""
		});
	} catch (err) {
		console.error("Error loading survey responses summary:", err);
		res.render("survey-responses", {
			user: userInfo,
			lessons: [],
			error_message: "Error loading survey responses."
		});
	}
});

// ============================================
// UPCOMING LESSONS PAGE
// ============================================

// Upcoming lessons route - GET (list view)
app.get("/upcoming-lesson", (req, res) => {
    const userInfo = getUserInfo(req);
    knex.select(
            'lesson.lessonid',
            'lesson.lessontitle',
            'lesson.lessondate',
            'lesson.classroom',
            'lesson.topic',
            'lesson.lessonoverview',
            'lesson.readingmaterials',
            'lesson.discussionquestions',
            'lesson.memberid',
            'members.memberfirstname',
            'members.memberlastname'
        )
        .from('lesson')
        .leftJoin('members', 'lesson.memberid', '=', 'members.memberid')
        .orderBy('lesson.lessondate', 'asc')
        .then(lessons => {
            // Format the lessons data for the template
            const formattedLessons = lessons.map(lesson => {
                // Get raw date in YYYY-MM-DD format for editing
                let rawDate = '';
                if (lesson.lessondate) {
                    if (lesson.lessondate instanceof Date) {
                        rawDate = lesson.lessondate.toISOString().split('T')[0];
                    } else if (typeof lesson.lessondate === 'string') {
                        rawDate = lesson.lessondate.split('T')[0];
                    }
                }
                return {
                    lessonid: lesson.lessonid,
                    lessonname: lesson.lessontitle,
                    date: formatDate(lesson.lessondate),
                    rawDate: rawDate,
                    location: lesson.classroom,
                    topics: lesson.topic,
                    description: lesson.lessonoverview,
                    reading: lesson.readingmaterials,
                    discussion: lesson.discussionquestions,
                    teacher: lesson.memberfirstname && lesson.memberlastname 
                        ? `${lesson.memberfirstname} ${lesson.memberlastname}` 
                        : 'N/A'
                };
            });
            
            // Get unique teachers and topics from the lessons
            const uniqueTeachers = [...new Set(formattedLessons
                .map(l => l.teacher)
                .filter(t => t && t !== 'N/A')
            )].sort();
            
            const uniqueTopics = [...new Set(formattedLessons
                .map(l => l.topics)
                .filter(t => t && t.trim() !== '')
            )].sort();
            
            res.render("upcoming-lesson", {
                user: userInfo || null,
                lessons: formattedLessons,
                teachers: uniqueTeachers,
                topics: uniqueTopics,
                error_message: null,
                isTeacher: userInfo && userInfo.isManager
            });
        })
        .catch(err => {
            console.error('Error fetching lessons:', err);
            res.render("upcoming-lesson", {
                user: userInfo || null,
                lessons: [],
                teachers: [],
                topics: [],
                error_message: "Error loading lessons. Please try again later."
            });
        });
});

// Add lesson route - POST (Teacher only)
app.post("/upcoming-lesson", (req, res) => {
	const userInfo = getUserInfo(req);
	if (!userInfo || !userInfo.isManager) {
		return res.status(403).json({ error: "Unauthorized" });
	}
	
	// Check if this is a PUT request via method override
	if (req.body._method === 'PUT') {
		const lessonId = parseInt(req.body.lessonId || req.url.split('/').pop());
		if (lessonId) {
			// Handle as PUT
			const { lessontitle, lessondate, classroom, topic, lessonoverview, readingmaterials, discussionquestions } = req.body;
			
			if (!lessontitle || !lessondate) {
				return res.status(400).json({ error: "Lesson title and date are required" });
			}
			
			return knex('lesson')
				.where('lessonid', lessonId)
				.update({
					lessontitle: lessontitle,
					lessondate: lessondate,
					classroom: classroom || null,
					topic: topic || null,
					lessonoverview: lessonoverview || null,
					readingmaterials: readingmaterials || null,
					discussionquestions: discussionquestions || null
				})
				.then(() => {
					res.redirect("/upcoming-lesson");
				})
				.catch(err => {
					console.error('Error updating lesson:', err);
					res.status(500).json({ error: "Error updating lesson" });
				});
		}
	}
	
	// Handle as POST (add new)
	const { lessontitle, lessondate, classroom, topic, lessonoverview, readingmaterials, discussionquestions } = req.body;
	
	if (!lessontitle || !lessondate) {
		return res.status(400).json({ error: "Lesson title and date are required" });
	}
	
	knex('lesson')
		.insert({
			lessontitle: lessontitle,
			lessondate: lessondate,
			classroom: classroom || null,
			topic: topic || null,
			lessonoverview: lessonoverview || null,
			readingmaterials: readingmaterials || null,
			discussionquestions: discussionquestions || null,
			memberid: userInfo.memberid
		})
		.then(() => {
			res.redirect("/upcoming-lesson");
		})
		.catch(err => {
			console.error('Error adding lesson:', err);
			res.status(500).json({ error: "Error adding lesson" });
		});
});

// Update lesson route - PUT (Teacher only)
app.put("/upcoming-lesson/:id", (req, res) => {
	const userInfo = getUserInfo(req);
	if (!userInfo || !userInfo.isManager) {
		return res.status(403).json({ error: "Unauthorized" });
	}
	
	const lessonId = parseInt(req.params.id);
	const { lessontitle, lessondate, classroom, topic, lessonoverview, readingmaterials, discussionquestions } = req.body;
	
	if (!lessontitle || !lessondate) {
		return res.status(400).json({ error: "Lesson title and date are required" });
	}
	
	knex('lesson')
		.where('lessonid', lessonId)
		.update({
			lessontitle: lessontitle,
			lessondate: lessondate,
			classroom: classroom || null,
			topic: topic || null,
			lessonoverview: lessonoverview || null,
			readingmaterials: readingmaterials || null,
			discussionquestions: discussionquestions || null
		})
		.then(() => {
			res.redirect("/upcoming-lesson");
		})
		.catch(err => {
			console.error('Error updating lesson:', err);
			res.status(500).json({ error: "Error updating lesson" });
		});
});

// Handle POST with _method=PUT for form submissions (edit)
app.post("/upcoming-lesson/:id", (req, res) => {
	if (req.body._method === 'PUT') {
		const userInfo = getUserInfo(req);
		if (!userInfo || !userInfo.isManager) {
			return res.status(403).json({ error: "Unauthorized" });
		}
		
		const lessonId = parseInt(req.params.id);
		const { lessontitle, lessondate, classroom, topic, lessonoverview, readingmaterials, discussionquestions } = req.body;
		
		if (!lessontitle || !lessondate) {
			return res.status(400).json({ error: "Lesson title and date are required" });
		}
		
		return knex('lesson')
			.where('lessonid', lessonId)
			.update({
				lessontitle: lessontitle,
				lessondate: lessondate,
				classroom: classroom || null,
				topic: topic || null,
				lessonoverview: lessonoverview || null,
				readingmaterials: readingmaterials || null,
				discussionquestions: discussionquestions || null
			})
			.then(() => {
				res.redirect("/upcoming-lesson");
			})
			.catch(err => {
				console.error('Error updating lesson:', err);
				res.status(500).json({ error: "Error updating lesson" });
			});
	}
	res.status(404).json({ error: "Not found" });
});

// Delete lesson route - DELETE (Teacher only)
app.delete("/upcoming-lesson/:id", (req, res) => {
	const userInfo = getUserInfo(req);
	if (!userInfo || !userInfo.isManager) {
		return res.status(403).json({ error: "Unauthorized" });
	}
	
	const lessonId = parseInt(req.params.id);
	
	knex('lesson')
		.where('lessonid', lessonId)
		.del()
		.then(() => {
			res.json({ success: true });
		})
		.catch(err => {
			console.error('Error deleting lesson:', err);
			res.status(500).json({ error: "Error deleting lesson" });
		});
});

// Lesson detail route - GET
app.get("/upcoming-lesson/:id", (req, res) => {
    const userInfo = getUserInfo(req);
    const lessonId = parseInt(req.params.id);
    
    knex.select(
            'lesson.lessonid',
            'lesson.lessontitle',
            'lesson.lessondate',
            'lesson.classroom',
            'lesson.topic',
            'lesson.lessonoverview',
            'lesson.readingmaterials',
            'lesson.discussionquestions',
            'lesson.memberid',
            'members.memberfirstname',
            'members.memberlastname'
        )
        .from('lesson')
        .leftJoin('members', 'lesson.memberid', '=', 'members.memberid')
        .where('lesson.lessonid', lessonId)
        .first()
        .then(lesson => {
            if (!lesson) {
                return res.render("lesson-detail", {
                    user: userInfo,
                    lesson: null
                });
            }
            
            // Format the lesson data for the template
            const formattedLesson = {
                lessonid: lesson.lessonid,
                lessonname: lesson.lessontitle,
                date: formatDate(lesson.lessondate),
                location: lesson.classroom,
                topics: lesson.topic,
                description: lesson.lessonoverview,
                reading: lesson.readingmaterials,
                discussion: lesson.discussionquestions,
                teacher: lesson.memberfirstname && lesson.memberlastname 
                    ? `${lesson.memberfirstname} ${lesson.memberlastname}` 
                    : 'N/A'
            };
            
            res.render("lesson-detail", {
                user: userInfo,
                lesson: formattedLesson
            });
        })
        .catch(err => {
            console.error('Error fetching lesson:', err);
            res.render("lesson-detail", {
                user: userInfo,
                lesson: null
            });
        });
});

app.get("/feedback", (req, res) => {
	const userInfo = getUserInfo(req);
	if (!userInfo || !userInfo.memberid) {
		return res.redirect("/login");
	}
	
	// Get lessons for survey
	knex.select(
			'lesson.lessonid',
			'lesson.lessontitle',
			'lesson.lessondate',
			'lesson.classroom',
			'lesson.topic',
			'lesson.lessonoverview',
			'lesson.readingmaterials',
			'lesson.discussionquestions',
			'members.memberfirstname',
			'members.memberlastname'
		)
		.from('lesson')
		.leftJoin('members', 'lesson.memberid', '=', 'members.memberid')
		.orderBy('lesson.lessondate', 'desc')
		.then(lessons => {
			const formattedLessons = lessons.map(lesson => {
				let rawDate = '';
				if (lesson.lessondate) {
					if (lesson.lessondate instanceof Date) {
						rawDate = lesson.lessondate.toISOString().split('T')[0];
					} else if (typeof lesson.lessondate === 'string') {
						rawDate = lesson.lessondate.split('T')[0];
					}
				}
				return {
					lessonid: lesson.lessonid,
					lessonname: lesson.lessontitle,
					date: formatDate(lesson.lessondate),
					rawDate: rawDate,
					location: lesson.classroom,
					topics: lesson.topic,
					description: lesson.lessonoverview,
					reading: lesson.readingmaterials,
					discussion: lesson.discussionquestions,
					teacher: lesson.memberfirstname && lesson.memberlastname 
						? `${lesson.memberfirstname} ${lesson.memberlastname}` 
						: 'N/A'
				};
			});
			res.render("feedback", {
				user: userInfo,
				lessons: formattedLessons,
				success: req.query.success === 'true',
				isTeacher: userInfo && userInfo.isManager
			});
		})
		.catch(err => {
			console.error('Error fetching lessons for feedback:', err);
			res.render("feedback", {
				user: userInfo,
				lessons: [],
				isTeacher: userInfo && userInfo.isManager
			});
		});
});

// ============================================
// SURVEY ROUTES
// ============================================

// Redirect old survey routes to feedback
app.get("/survey", (req, res) => {
	res.redirect("/feedback");
});

app.get("/survey/:lessonid", (req, res) => {
	res.redirect(`/feedback/survey/${req.params.lessonid}`);
});

// Survey form for a specific lesson (redirected to feedback)
app.get("/feedback/survey/:lessonid", async (req, res) => {
	const userInfo = getUserInfo(req);
	if (!userInfo || !userInfo.memberid) {
		return res.redirect("/login");
	}
	
	const lessonId = parseInt(req.params.lessonid);
	
	try {
		const lesson = await knex.select(
				'lesson.lessonid',
				'lesson.lessontitle',
				'lesson.lessondate',
				'members.memberfirstname',
				'members.memberlastname'
			)
			.from('lesson')
			.leftJoin('members', 'lesson.memberid', '=', 'members.memberid')
			.where('lesson.lessonid', lessonId)
			.first();

		if (!lesson) {
			return res.redirect("/feedback");
		}

		const formattedLesson = {
			lessonid: lesson.lessonid,
			lessonname: lesson.lessontitle,
			date: formatDate(lesson.lessondate),
			teacher: lesson.memberfirstname && lesson.memberlastname 
				? `${lesson.memberfirstname} ${lesson.memberlastname}` 
				: 'N/A'
		};

		const questions = await getSurveyQuestionsForLesson(lessonId);

		const existingResponses = await knex.select('*')
			.from('survey_response')
			.where('memberid', userInfo.memberid)
			.where('lessonid', lessonId);

		const responsesByQuestion = {};
		if (existingResponses && existingResponses.length > 0) {
			existingResponses.forEach(resp => {
				responsesByQuestion[resp.question] = {
					response: resp.response,
					extracomments: resp.extracomments
				};
			});
		}

		res.render("feedback-survey-form", {
			user: userInfo,
			lesson: formattedLesson,
			questions,
			existingResponses: responsesByQuestion
		});
	} catch (err) {
		console.error('Error fetching lesson for survey:', err);
		res.redirect("/feedback");
	}
});

// Submit survey responses
app.post("/feedback/survey/:lessonid", async (req, res) => {
	const userInfo = getUserInfo(req);
	if (!userInfo || !userInfo.memberid) {
		return res.redirect("/login");
	}
	
	const lessonId = parseInt(req.params.lessonid);
	const memberId = userInfo.memberid;

	const questions = await getSurveyQuestionsForLesson(lessonId);
	
	// Get responses from form
	const responses = questions.map((question, index) => {
		const questionKey = `question_${index + 1}`;
		const commentKey = `comment_${index + 1}`;
		return {
			question: question,
			response: parseInt(req.body[questionKey]) || null,
			extracomments: req.body[commentKey] || null
		};
	});
	
	// Delete existing responses for this lesson and member (keep definition rows where response IS NULL)
	knex('survey_response')
		.where('memberid', memberId)
		.where('lessonid', lessonId)
		.whereNotNull('response')
		.del()
		.then(() => {
			// Insert new responses
			const insertData = responses
				.filter(r => r.response !== null)
				.map(r => ({
					memberid: memberId,
					lessonid: lessonId,
					question: r.question,
					response: r.response,
					extracomments: r.extracomments
				}));
			
			if (insertData.length > 0) {
				return knex('survey_response').insert(insertData);
			}
			return Promise.resolve();
		})
		.then(() => {
			res.redirect("/feedback?success=true");
		})
		.catch(err => {
			console.error('Error saving survey responses:', err);
			res.redirect(`/feedback/survey/${lessonId}?error=true`);
		});
});

app.post("/feedback", async (req, res) => {
	const { name, email, category, feedback } = req.body;
	
	try {
		// You can save feedback to database here if needed
		// For now, just log it and show success message
		console.log('Feedback received:', { name, email, category, feedback });
		
		// Optionally save to database
		// await pool.query(
		//     'INSERT INTO feedback (name, email, category, feedback, created_at) VALUES ($1, $2, $3, $4, NOW())',
		//     [name, email || null, category, feedback]
		// );
		
		return res.render("feedback", { 
			success: true,
			message: "Thank you for your feedback! We appreciate your input." 
		});
	} catch (error) {
		console.error('Error saving feedback:', error);
		return res.render("feedback", { 
			error: true,
			message: "There was an error submitting your feedback. Please try again." 
		});
	}
});

// Get survey questions for a lesson (teacher only)
app.get("/feedback/survey/:lessonid/questions-json", async (req, res) => {
	const userInfo = getUserInfo(req);
	if (!userInfo || !userInfo.isManager) {
		return res.status(403).json({ error: "Unauthorized" });
	}
	const lessonId = parseInt(req.params.lessonid);
	try {
		const questions = await getSurveyQuestionsForLesson(lessonId);
		res.json({ questions });
	} catch (err) {
		console.error('Error getting survey questions JSON:', err);
		res.status(500).json({ error: "Error fetching questions" });
	}
});

// Update survey questions for a lesson (teacher only)
app.post("/feedback/survey/:lessonid/questions", async (req, res) => {
	const userInfo = getUserInfo(req);
	if (!userInfo || !userInfo.isManager) {
		return res.status(403).json({ error: "Unauthorized" });
	}
	const lessonId = parseInt(req.params.lessonid);

	// Collect questions from form (question_1, question_2, ...)
	const questions = Object.keys(req.body)
		.filter(k => k.startsWith('question_'))
		.sort()
		.map(k => (req.body[k] || '').trim())
		.filter(q => q.length > 0);

	if (questions.length === 0) {
		return res.status(400).json({ error: "At least one question is required" });
	}

	try {
		// Remove existing definition rows (response null)
		await knex('survey_response')
			.where('lessonid', lessonId)
			.whereNull('response')
			.del();

		// Insert new definitions with ordering stored in extracomments
		const rows = questions.map((q, idx) => ({
			memberid: userInfo.memberid, // use teacher's memberid to satisfy NOT NULL
			lessonid: lessonId,
			question: q,
			response: null, // mark as definition row
			extracomments: String(idx)
		}));

		await knex('survey_response').insert(rows);
		res.json({ success: true });
	} catch (err) {
		console.error('Error saving survey questions:', err);
		res.status(500).json({ error: "Error saving survey questions" });
	}
});


app.get("/logout", (req, res) => {
	req.session.destroy(() => {
		res.redirect("/login");
	});
});

app.listen(port, () => {
    console.log("The server is listening");
});

