import * as path from 'path';

import * as express from 'express';
import asyncHandler from 'express-async-handler';
import { z } from 'zod';
import fs from 'fs-extra';

import * as error from '@prairielearn/error';
import { flash } from '@prairielearn/flash';
import * as sqldb from '@prairielearn/postgres';
import { generateSignedToken } from '@prairielearn/signed-token';

import { config } from '../../lib/config.js';
import { copyQuestionBetweenCourses } from '../../lib/copy-question.js';
import { IdSchema } from '../../lib/db-types.js';
import {
  QuestionRenameEditor,
  QuestionDeleteEditor,
  QuestionCopyEditor,
} from '../../lib/editors.js';
import { features } from '../../lib/features/index.js';
import { idsEqual } from '../../lib/id.js';
import { startTestQuestion } from '../../lib/question-testing.js';
import { encodePath } from '../../lib/uri-util.js';
import { getCanonicalHost } from '../../lib/url.js';
import { selectCoursesWithEditAccess } from '../../models/course.js';
import { FileModifyEditor } from '../../lib/editors.js';
import { b64EncodeUnicode } from '../../lib/base64-util.js';
import { getPaths } from '../../lib/instructorFiles.js';

import {
  InstructorQuestionSettings,
  SelectedAssessmentsSchema,
  SharingSetRowSchema,
} from './instructorQuestionSettings.html.js';

const router = express.Router();
const sql = sqldb.loadSqlEquiv(import.meta.url);

async function editPublicSharingWithSource(
  course_id: string,
  question_id: string,
  share_source_code: boolean,
) {
  if (share_source_code == null) {
    share_source_code = false;
  }
  await sqldb.queryAsync(sql.update_question_shared_publicly_with_source, {
    course_id,
    question_id,
    share_source_code,
  });
}

router.post(
  '/test',
  asyncHandler(async (req, res) => {
    if (res.locals.question.course_id !== res.locals.course.id) {
      throw new error.HttpStatusError(403, 'Access denied');
    }
    // We use a separate `test/` POST route so that we can always use the
    // route to distinguish between pages that need to execute course code
    // (this `test/` handler) and pages that need access to course content
    // editing (here the plain '/' POST handler).
    if (req.body.__action === 'test_once') {
      if (!res.locals.authz_data.has_course_permission_view) {
        throw new error.HttpStatusError(403, 'Access denied (must be a course Viewer)');
      }
      const count = 1;
      const showDetails = true;
      const jobSequenceId = await startTestQuestion(
        count,
        showDetails,
        res.locals.question,
        res.locals.course_instance,
        res.locals.course,
        res.locals.authn_user.user_id,
      );
      res.redirect(res.locals.urlPrefix + '/jobSequence/' + jobSequenceId);
    } else if (req.body.__action === 'test_100') {
      if (!res.locals.authz_data.has_course_permission_view) {
        throw new error.HttpStatusError(403, 'Access denied (must be a course Viewer)');
      }
      if (res.locals.question.grading_method !== 'External') {
        const count = 100;
        const showDetails = false;
        const jobSequenceId = await startTestQuestion(
          count,
          showDetails,
          res.locals.question,
          res.locals.course_instance,
          res.locals.course,
          res.locals.authn_user.user_id,
        );
        res.redirect(res.locals.urlPrefix + '/jobSequence/' + jobSequenceId);
      } else {
        throw new Error('Not supported for externally-graded questions');
      }
    } else {
      throw new error.HttpStatusError(400, `unknown __action: ${req.body.__action}`);
    }
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    if (res.locals.question.course_id !== res.locals.course.id) {
      throw new error.HttpStatusError(403, 'Access denied');
    }
    if (req.body.__action === 'change_id') {
      if (!req.body.id) {
        throw new error.HttpStatusError(400, `Invalid QID (was falsy): ${req.body.id}`);
      }
      if (!/^[-A-Za-z0-9_/]+$/.test(req.body.id)) {
        throw new error.HttpStatusError(
          400,
          `Invalid QID (was not only letters, numbers, dashes, slashes, and underscores, with no spaces): ${req.body.id}`,
        );
      }
      let qid_new;
      try {
        qid_new = path.normalize(req.body.id);
      } catch (err) {
        throw new error.HttpStatusError(
          400,
          `Invalid QID (could not be normalized): ${req.body.id}`,
        );
      }
      if (res.locals.question.qid === qid_new) {
        res.redirect(req.originalUrl);
      } else {
        const editor = new QuestionRenameEditor({
          locals: res.locals,
          qid_new,
        });
        const serverJob = await editor.prepareServerJob();
        try {
          await editor.executeWithServerJob(serverJob);
          res.redirect(req.originalUrl);
        } catch (err) {
          res.redirect(res.locals.urlPrefix + '/edit_error/' + serverJob.jobSequenceId);
        }
      }
    } else if (req.body.__action === 'copy_question') {
      if (idsEqual(req.body.to_course_id, res.locals.course.id)) {
        // In this case, we are making a duplicate of this question in the same course
        const editor = new QuestionCopyEditor({
          locals: res.locals,
        });
        const serverJob = await editor.prepareServerJob();
        try {
          await editor.executeWithServerJob(serverJob);
        } catch (err) {
          return res.redirect(res.locals.urlPrefix + '/edit_error/' + serverJob.jobSequenceId);
        }
        const questionId = await sqldb.queryRow(
          sql.select_question_id_from_uuid,
          { uuid: editor.uuid, course_id: res.locals.course.id },
          IdSchema,
        );
        flash(
          'success',
          'Question copied successfully. You are now viewing your copy of the question.',
        );
        res.redirect(res.locals.urlPrefix + '/question/' + questionId + '/settings');
      } else {
        await copyQuestionBetweenCourses(res, {
          fromCourse: res.locals.course,
          toCourseId: req.body.to_course_id,
          question: res.locals.question,
        });
      }
    } else if (req.body.__action === 'delete_question') {
      const editor = new QuestionDeleteEditor({
        locals: res.locals,
      });
      const serverJob = await editor.prepareServerJob();
      try {
        await editor.executeWithServerJob(serverJob);
        res.redirect(res.locals.urlPrefix + '/course_admin/questions');
      } catch (err) {
        res.redirect(res.locals.urlPrefix + '/edit_error/' + serverJob.jobSequenceId);
      }
    } else if (req.body.__action === 'sharing_set_add') {
      const questionSharingEnabled = await features.enabledFromLocals(
        'question-sharing',
        res.locals,
      );
      if (!questionSharingEnabled) {
        throw new error.HttpStatusError(403, 'Access denied (feature not available)');
      }
      if (!res.locals.authz_data.has_course_permission_own) {
        throw new error.HttpStatusError(403, 'Access denied (must be a course Owner)');
      }
      await sqldb.queryAsync(sql.sharing_set_add, {
        course_id: res.locals.course.id,
        question_id: res.locals.question.id,
        unsafe_sharing_set_id: req.body.unsafe_sharing_set_id,
      });
      res.redirect(req.originalUrl);
    } else if (req.body.__action === 'share_publicly') {
      const questionSharingEnabled = await features.enabledFromLocals(
        'question-sharing',
        res.locals,
      );
      if (!questionSharingEnabled) {
        throw new error.HttpStatusError(403, 'Access denied (feature not available)');
      }
      if (!res.locals.authz_data.has_course_permission_own) {
        throw new error.HttpStatusError(403, 'Access denied (must be a course Owner)');
      }
      await sqldb.queryAsync(sql.update_question_shared_publicly, {
        course_id: res.locals.course.id,
        question_id: res.locals.question.id,
      });
      
      if (req.body.share_source_code != null) {
        await editPublicSharingWithSource(
          res.locals.course.id,
          res.locals.question.id,
          req.body.share_source_code,
      )};

      res.redirect(req.originalUrl);

      // TEST START
      // TEST, new way since we're editing JSON instead of updating the DB
      if (!(await fs.pathExists(path.join(res.locals.course.path, 'questions', res.locals.question.qid, 'info.json')))) { 
        throw new error.HttpStatusError(400, 'info.json does not exist'); 
      } 
      const paths = getPaths(req, res);
      
      console.log('paths', paths)// TEST

      const questionInfo = JSON.parse(
          await fs.readFile(path.join(res.locals.course.path, 'questions', res.locals.question.qid, 'info.json'), 'utf8'),
      );

      console.log('questionInfo', questionInfo)// TEST
      
      const origHash = req.body.orig_hash; 

      console.log('origHash', origHash)// TEST
      
      const questionInfoEdit = questionInfo; 
      questionInfoEdit.name = req.body.short_name; 
      questionInfoEdit.title = req.body.title; 
      questionInfoEdit.timezone = req.body.display_timezone; 

      console.log('questionInfoEdit', questionInfoEdit)// TEST
      
      const editor = new FileModifyEditor({ 
        locals: res.locals, 
        container: { 
          rootPath: paths.rootPath, 
          invalidRootPaths: paths.invalidRootPaths, 
        }, 
        filePath: path.join(res.locals.course.path, 'questions', res.locals.question.qid, 'info.json'), 
        editContents: b64EncodeUnicode(JSON.stringify(questionInfoEdit, null, 2)), 
        origHash, 
      });

      console.log('editor', editor)// TEST 
      // TEST END
        
      
    } else if (req.body.__action === 'edit_public_sharing') {
      await editPublicSharingWithSource(
        res.locals.course.id,
        res.locals.question.id,
        req.body.share_source_code,
      );
      
      
      res.redirect(req.originalUrl);
      // TEST edit here too
      
    } else {
      throw new error.HttpStatusError(400, `unknown __action: ${req.body.__action}`);
    }
  })
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    if (res.locals.question.course_id !== res.locals.course.id) {
      throw new error.HttpStatusError(403, 'Access denied');
    }
    // Construct the path of the question test route. We'll do this based on
    // `originalUrl` so that this router doesn't have to be aware of where it's
    // mounted.
    const host = getCanonicalHost(req);
    let questionTestPath = new URL(`${host}${req.originalUrl}`).pathname;
    if (!questionTestPath.endsWith('/')) {
      questionTestPath += '/';
    }
    questionTestPath += 'test';

    // Generate a CSRF token for the test route. We can't use `res.locals.__csrf_token`
    // here because this form will actually post to a different route, not `req.originalUrl`.
    const questionTestCsrfToken = generateSignedToken(
      { url: questionTestPath, authn_user_id: res.locals.authn_user.user_id },
      config.secretKey,
    );

    let questionGHLink: string | null = null;
    if (res.locals.course.repository) {
      const githubRepoMatch = res.locals.course.repository.match(
        /^git@github.com:\/?(.+?)(\.git)?\/?$/,
      );
      if (githubRepoMatch) {
        questionGHLink =
          'https://github.com/' +
          githubRepoMatch[1] +
          `/tree/${res.locals.course.branch}/questions/` +
          res.locals.question.qid;
      }
    } else if (res.locals.course.example_course) {
      questionGHLink = `https://github.com/PrairieLearn/PrairieLearn/tree/master/exampleCourse/questions/${res.locals.question.qid}`;
    }

    const qids = await sqldb.queryRows(sql.qids, { course_id: res.locals.course.id }, z.string());

    const assessmentsWithQuestion = await sqldb.queryRows(
      sql.select_assessments_with_question_for_display,
      { question_id: res.locals.question.id },
      SelectedAssessmentsSchema,
    );
    const sharingEnabled = await features.enabledFromLocals('question-sharing', res.locals);

    let sharingSetsIn, sharingSetsOther;
    if (sharingEnabled) {
      const result = await sqldb.queryRows(
        sql.select_sharing_sets,
        {
          question_id: res.locals.question.id,
          course_id: res.locals.course.id,
        },
        SharingSetRowSchema,
      );
      sharingSetsIn = result.filter((row) => row.in_set);
      sharingSetsOther = result.filter((row) => !row.in_set);
    }
    const editableCourses = await selectCoursesWithEditAccess({
      user_id: res.locals.user.user_id,
      is_administrator: res.locals.is_administrator,
    });
    const infoPath = encodePath(path.join('questions', res.locals.question.qid, 'info.json'));

    res.send(
      InstructorQuestionSettings({
        resLocals: res.locals,
        questionTestPath,
        questionTestCsrfToken,
        questionGHLink,
        qids,
        assessmentsWithQuestion,
        sharingEnabled,
        sharingSetsIn,
        sharingSetsOther,
        editableCourses,
        infoPath,
      }),
    );
  }),
);

export default router;
