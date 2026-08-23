import  * as Joi from 'joi';


export const envValidationSchema=Joi.object({

    DATABASE_URL:Joi.string().required(),
    PORT:Joi.number().default(3000),
    JWT_ACCESS_SECRET:Joi.string().min(16).required(),
    JWT_REFRESH_SECRET:Joi.string().min(16).required()
});